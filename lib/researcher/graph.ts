// The Researcher's graph: router → executor → composer, built on
// LangGraph's StateGraph. Deliberately NOT a ReAct loop — the 4B routes
// once inside a grammar, deterministic TypeScript executes, and one more
// call writes prose. Streaming happens through an emit closure captured
// by the nodes (SSE-friendly and independent of checkpointer machinery;
// threads persist in our own tables, see threads.ts).
import { StateGraph, Annotation, START, END } from '@langchain/langgraph';
import { nanoid } from 'nanoid';
import { routeQuestion } from './router';
import { composeAnswer, followupsFor, templateAnswer } from './composer';
import { TOOLS, TOOL_TIMEOUT_MS, withTimeout, floorStep, type ToolOutcome } from './tools';
import type { AssistantPayload, Footprint, ResearcherEvent, ResearchPlan } from './types';

export interface RunResult {
  content: string;
  payload: AssistantPayload;
}

// One interactive lane by default: with LLAMA_ARG_PARALLEL=2 the other
// slot belongs to background summaries, so a question never queues
// behind a background job. A second concurrent QUESTION doesn't get
// rejected outright either — it's held in a small FIFO queue and
// started the moment the slot frees, so two people (or two tabs) using
// the Researcher at once both get real answers without a manual retry.
// Only once the queue itself is full does a request get an immediate,
// honest "busy".
const MAX_CONCURRENT = Math.max(1, parseInt(process.env.RESEARCHER_CONCURRENCY || '1', 10) || 1);
const MAX_QUEUE = 12;
const QUEUE_TIMEOUT_MS = 90_000;
let active = 0;

interface Waiter { resolve: (v: 'ok' | 'timeout') => void; timer: ReturnType<typeof setTimeout> }
const waiters: Waiter[] = [];

export interface SlotClaim {
  /** Resolves once a slot is granted ('ok') or the wait exceeded the cap
   * ('timeout') — never rejects. */
  ready: Promise<'ok' | 'timeout'>;
  /** 1-based queue position at claim time; 0 = started immediately. */
  position: number;
}

/** Null only when the queue itself is already full (MAX_QUEUE waiters) —
 * that's the one case still worth an immediate "busy" rather than making
 * someone wait behind a dozen others. */
export function acquireSlot(): SlotClaim | null {
  if (active < MAX_CONCURRENT) {
    active++;
    return { ready: Promise.resolve('ok'), position: 0 };
  }
  if (waiters.length >= MAX_QUEUE) return null;
  const position = waiters.length + 1;
  let waiter!: Waiter;
  const ready = new Promise<'ok' | 'timeout'>((resolve) => {
    waiter = {
      resolve: (v) => { if (v === 'ok') active++; resolve(v); },
      timer: setTimeout(() => {
        const idx = waiters.indexOf(waiter);
        if (idx >= 0) { waiters.splice(idx, 1); waiter.resolve('timeout'); }
      }, QUEUE_TIMEOUT_MS),
    };
  });
  waiters.push(waiter);
  return { ready, position };
}

export function releaseSlot(): void {
  active = Math.max(0, active - 1);
  const next = waiters.shift();
  if (next) { clearTimeout(next.timer); next.resolve('ok'); }
}

const RunState = Annotation.Root({
  question: Annotation<string>,
  historyBrief: Annotation<string>,
  plan: Annotation<ResearchPlan | null>,
  outcomes: Annotation<ToolOutcome[]>,
  content: Annotation<string>,
});

export async function runResearch(opts: {
  projectId: string;
  question: string;
  historyBrief: string;
  emit: (e: ResearcherEvent) => void;
  signal?: AbortSignal;
  fetchFn?: typeof fetch;
}): Promise<RunResult> {
  const { projectId, question, historyBrief, emit, signal, fetchFn = fetch } = opts;
  const footprints: Footprint[] = [];
  const blocks: AssistantPayload['blocks'] = [];
  const citations: AssistantPayload['citations'] = [];
  const caveats: string[] = [];

  const throwIfAborted = () => {
    if (signal?.aborted) throw new Error('aborted');
  };

  const routerNode = async (state: typeof RunState.State) => {
    throwIfAborted();
    const started = Date.now();
    emit({ type: 'tool', name: 'route', label: 'Reading the question', status: 'start' });
    const { plan } = await routeQuestion(state.question, state.historyBrief, fetchFn);
    const ms = Date.now() - started;
    footprints.push({ name: 'route', label: 'Read the question', ms });
    emit({ type: 'tool', name: 'route', label: 'Read the question', status: 'done', ms });
    return { plan };
  };

  const executorNode = async (state: typeof RunState.State) => {
    const plan = state.plan!;
    const outcomes: ToolOutcome[] = [];
    if (plan.fromHistory || plan.steps.length === 0) return { outcomes };
    let allFailed = true;
    for (const step of plan.steps) {
      throwIfAborted();
      const tool = TOOLS[step.tool];
      if (!tool) continue;
      const started = Date.now();
      emit({ type: 'tool', name: tool.name, label: tool.label, status: 'start' });
      try {
        const outcome = await withTimeout(tool.run(projectId, step.args), TOOL_TIMEOUT_MS, tool.label);
        const ms = Date.now() - started;
        footprints.push({ name: tool.name, label: tool.label, ms });
        emit({ type: 'tool', name: tool.name, label: tool.label, status: 'done', ms });
        outcomes.push(outcome);
        allFailed = false;
        // Held back on purpose — blocks appear only after the composer's
        // prose has fully streamed (flushed at the end of composerNode).
        // Tool-status footprints above still update live throughout.
        for (const b of outcome.blocks) {
          if (blocks.length < 6) blocks.push(b);
        }
        citations.push(outcome.citation);
        if (outcome.caveat) caveats.push(outcome.caveat);
      } catch (e) {
        const ms = Date.now() - started;
        if (signal?.aborted) throw e;
        footprints.push({ name: tool.name, label: `${tool.label} (failed)`, ms });
        emit({ type: 'tool', name: tool.name, label: tool.label, status: 'error', ms });
      }
    }
    // Never-dead-end: a fully failed plan still grounds the answer.
    if (allFailed) {
      const fallback = floorStep();
      const tool = TOOLS[fallback.tool];
      const started = Date.now();
      emit({ type: 'tool', name: tool.name, label: tool.label, status: 'start' });
      try {
        const outcome = await withTimeout(tool.run(projectId, fallback.args), TOOL_TIMEOUT_MS, tool.label);
        const ms = Date.now() - started;
        footprints.push({ name: tool.name, label: tool.label, ms });
        emit({ type: 'tool', name: tool.name, label: tool.label, status: 'done', ms });
        outcomes.push(outcome);
        for (const b of outcome.blocks) {
          if (blocks.length < 6) blocks.push(b);
        }
        citations.push(outcome.citation);
        if (outcome.caveat) caveats.push(outcome.caveat);
      } catch {
        emit({ type: 'tool', name: tool.name, label: tool.label, status: 'error', ms: Date.now() - started });
      }
    }
    // Tag flow: the draft card renders from the plan + preview count. When
    // the model previewed a rule but forgot to fill tag_draft, synthesize
    // the draft from the preview step — the card must never depend on the
    // 4B remembering both halves.
    let draft = plan.tagDraft;
    if (!draft) {
      const previewStep = plan.steps.find((s) => s.tool === 'preview_tag_rule');
      const v = typeof previewStep?.args.value === 'string' ? previewStep.args.value.trim() : '';
      if (previewStep && v) {
        draft = {
          name: `${v.replace(/^\//, '').replace(/[^a-z0-9 _-]/gi, ' ').trim() || 'Matched'} visitors`.slice(0, 60),
          kind: previewStep.args.kind === 'session_count_gte' ? 'session_count_gte' : 'url_contains',
          value: v,
          color: 'blue',
        };
      }
    }
    if (draft) {
      const preview = outcomes.find((o) => 'tagPreview' in o.facts);
      const p = preview?.facts.tagPreview as { matchCount: number; approx: boolean } | undefined;
      const draftBlock = {
        type: 'tagDraft' as const,
        draftId: nanoid(10),
        name: draft.name,
        kind: draft.kind,
        value: draft.value,
        color: draft.color,
        matchCount: p?.matchCount ?? 0,
        approx: p?.approx ?? true,
      };
      // Held back like every other block — appears after the text below.
      blocks.push(draftBlock);
    }
    return { outcomes };
  };

  const composerNode = async (state: typeof RunState.State) => {
    throwIfAborted();
    const plan = state.plan!;
    const started = Date.now();
    let content = '';
    const draftBlock = blocks.find((b) => b.type === 'tagDraft');
    try {
      // No hardcoded smalltalk shortcut here on purpose: it used to fire
      // for ANY zero-outcome turn the router labeled "smalltalk",
      // including real contextual follow-ups ("what does it mean?") that
      // the router sometimes mislabels — discarding the conversation
      // history entirely and giving a canned brush-off instead of an
      // answer. The composer LLM always runs now; its system prompt
      // covers both genuine smalltalk and history-grounded follow-ups.
      if (draftBlock && draftBlock.type === 'tagDraft') {
        // Tag flow speaks in the mock's exact voice, deterministically —
        // crisp, correct, and no LLM latency between preview and Apply.
        const preview = state.outcomes.find((o) => 'tagPreview' in o.facts);
        const p = preview?.facts.tagPreview as { matchCount: number; visitorCount?: number; approx: boolean } | undefined;
        const what = draftBlock.kind === 'url_contains'
          ? `every future visit touching “${draftBlock.value}”`
          : `every visitor reaching ${draftBlock.value}+ sessions`;
        const visitors = p?.visitorCount ? ` from ${p.visitorCount} visitors` : '';
        content = p && p.matchCount > 0
          ? `Ready — it would tag ${p.matchCount}${p.approx ? '+' : ''} past sessions${visitors}, plus ${what}.`
          : `Ready — nothing matches yet, but the rule will catch ${what} from now on.`;
        emit({ type: 'token', text: content });
      } else {
        content = await composeAnswer({
          question: state.question,
          plan,
          outcomes: state.outcomes,
          historyBrief: state.historyBrief,
          onToken: (t) => emit({ type: 'token', text: t }),
          signal,
          fetchFn,
        });
      }
    } finally {
      // Runs even if composeAnswer threw from a mid-stream Stop: the
      // blocks the executor already computed (chart data, evidence,
      // session rows) still reveal themselves rather than vanishing
      // along with the aborted call. Text-before-artifact is preserved
      // either way — nothing here emits before the prose already has.
      footprints.push({ name: 'compose', label: 'Wrote the answer', ms: Date.now() - started });
      for (const b of blocks) emit({ type: 'block', block: b });
    }
    return { content };
  };

  const graph = new StateGraph(RunState)
    .addNode('router', routerNode)
    .addNode('executor', executorNode)
    .addNode('composer', composerNode)
    .addEdge(START, 'router')
    .addEdge('router', 'executor')
    .addEdge('executor', 'composer')
    .addEdge('composer', END)
    .compile();

  let finalState: typeof RunState.State;
  let interrupted = false;
  try {
    finalState = await graph.invoke({ question, historyBrief, plan: null, outcomes: [], content: '' });
  } catch (e) {
    if (signal?.aborted) {
      // Stop pressed mid-run: keep whatever landed; the client shows
      // "Response interrupted".
      interrupted = true;
      finalState = { question, historyBrief, plan: heuristicNull(), outcomes: [], content: '' };
    } else {
      throw e;
    }
  }

  const plan = finalState.plan ?? heuristicNull();
  const content = interrupted
    ? finalState.content || ''
    : finalState.content || templateAnswer(plan, finalState.outcomes ?? []);
  // The model may plan the same tool twice — one chip per distinct query.
  const seenCites = new Set<string>();
  const dedupedCitations = citations.filter((c) => {
    const k = `${c.label}|${c.detail}`;
    if (seenCites.has(k)) return false;
    seenCites.add(k);
    return true;
  });
  // The brass view-nav: one deep link into the exact dashboard view the
  // answer came from (mock's "See the timeline slice →").
  const LINK_LABELS: Record<string, string> = {
    overview: 'Open the overview →',
    timeline: 'Open this timeline →',
    sessions: 'Open these sessions →',
    visitors: 'Open the visitors →',
    clusters: 'Open the cluster map →',
    session_detail: 'Watch the replay →',
    tag: 'Open the tags page →',
    followup: 'Open this view →',
  };
  const primary = citations.find((c) => c.href);
  const link = !interrupted && primary?.href
    ? { label: LINK_LABELS[plan.intent] ?? 'Open this view →', href: primary.href }
    : null;

  const payload: AssistantPayload = {
    blocks,
    citations: dedupedCitations,
    caveat: caveats[0] ?? null,
    followups: interrupted ? [] : followupsFor(plan, finalState.outcomes ?? [], question),
    footprints,
    link,
    ...(interrupted ? { interrupted: true } : {}),
  };
  return { content, payload };
}

function heuristicNull(): ResearchPlan {
  return { intent: 'overview', fromHistory: false, steps: [], tagDraft: null };
}
