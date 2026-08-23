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
// behind a 25s vision job. Overflow gets an honest "busy" instead of a
// silent hang.
const MAX_CONCURRENT = Math.max(1, parseInt(process.env.RESEARCHER_CONCURRENCY || '1', 10) || 1);
let active = 0;

export function tryAcquireSlot(): boolean {
  if (active >= MAX_CONCURRENT) return false;
  active++;
  return true;
}
export function releaseSlot(): void {
  active = Math.max(0, active - 1);
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
        for (const b of outcome.blocks) {
          if (blocks.length < 4) { blocks.push(b); emit({ type: 'block', block: b }); }
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
          if (blocks.length < 4) { blocks.push(b); emit({ type: 'block', block: b }); }
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
      blocks.push(draftBlock);
      emit({ type: 'block', block: draftBlock });
    }
    return { outcomes };
  };

  const composerNode = async (state: typeof RunState.State) => {
    throwIfAborted();
    const plan = state.plan!;
    const started = Date.now();
    let content: string;
    if (plan.intent === 'smalltalk' && state.outcomes.length === 0) {
      content = 'Happy to help — ask me anything about your sessions, visitors, trends, or segments.';
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
    footprints.push({ name: 'compose', label: 'Wrote the answer', ms: Date.now() - started });
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
  const payload: AssistantPayload = {
    blocks,
    citations: dedupedCitations,
    caveat: caveats[0] ?? null,
    followups: interrupted ? [] : followupsFor(plan, finalState.outcomes ?? []),
    footprints,
    ...(interrupted ? { interrupted: true } : {}),
  };
  return { content, payload };
}

function heuristicNull(): ResearchPlan {
  return { intent: 'overview', fromHistory: false, steps: [], tagDraft: null };
}
