// The router: one grammar-forced LLM call that turns a question into a
// typed plan of ≤3 tool steps. The 4B never free-forms here — llama.cpp
// compiles PLAN_SCHEMA to a grammar, so output is valid JSON by
// construction; code still validates semantics and repairs once.
// When no LLM is configured (OSS mode) or the call fails, a keyword
// heuristic produces a sensible plan instead — the never-dead-end floor.
import { llmChatJson } from '@/lib/llm-service';
import { TOOLS, floorStep } from './tools';
import type { ResearchPlan } from './types';

export const PLAN_INTENTS = [
  'overview', 'timeline', 'sessions', 'visitors', 'clusters', 'session_detail', 'tag', 'followup', 'smalltalk',
] as const;

const TOOL_NAMES = Object.keys(TOOLS);

// Kept intentionally GBNF-friendly: enums, plain objects, no pattern refs.
export const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    intent: { type: 'string', enum: [...PLAN_INTENTS] },
    from_history: { type: 'boolean' },
    steps: {
      type: 'array',
      maxItems: 3,
      items: {
        type: 'object',
        properties: {
          tool: { type: 'string', enum: TOOL_NAMES },
          args: { type: 'object' },
        },
        required: ['tool', 'args'],
        additionalProperties: false,
      },
    },
    tag_draft: {
      anyOf: [
        { type: 'null' },
        {
          type: 'object',
          properties: {
            name: { type: 'string' },
            kind: { type: 'string', enum: ['url_contains', 'session_count_gte'] },
            value: { type: 'string' },
            color: { type: 'string', enum: ['green', 'blue', 'purple', 'amber', 'red', 'gray'] },
          },
          required: ['name', 'kind', 'value', 'color'],
          additionalProperties: false,
        },
      ],
    },
  },
  required: ['intent', 'from_history', 'steps', 'tag_draft'],
  additionalProperties: false,
} as const;

// Static prefix — identical across calls so llama.cpp's cache_prompt
// keeps it in the KV cache and routing costs only the question's tokens.
export const ROUTER_SYSTEM = `You translate an analytics question into a JSON research plan. You never answer the question yourself — you only choose which tools will fetch the evidence.

The product records website visitor sessions (replays) and derives: AI session summaries, visitor profiles, behavioral segments (clusters), an hourly timeline, and admin-defined tags.

Your tools — what each one is for:
- overview_snapshot {range}: the general health check — headline numbers, needs-attention callouts, noteworthy sessions, top segments. For broad questions ("how are we doing?") and whenever nothing more specific fits.
- get_timeline {range, focus?}: how things move over time — totals and trends vs the previous window. For anything about growth, drops, spikes, peaks, or where traffic comes from. focus narrows to one lens: sources|devices|browsers|countries|referrers|entries|friction.
- query_sessions {range?, user?, tag?, device?, source?, country?, browser?, path?, minSeconds?, frustratedOnly?, newOnly?, sort?, limit?}: concrete recordings to watch. For when the user wants actual sessions — to see, count, or filter them. device mobile|tablet|desktop. source search|referral|ads|social|internal|direct. sort recent|longest|most_pages.
- query_visitors {range?, sort?, limit?}: people rather than visits — visitors grouped with totals and AI profiles. For "who" questions. sort sessions|time|recent.
- get_clusters {dimension?, segment?, range?}: behavioral segments. For "what kinds of visitors" questions, or a named segment (segment spotlights it on the map). dimension overall|persona|intent|source|experience. Omit range for all-time; set it only when the user names a window.
- session_digest {sessionId}: everything about ONE session. Needs a real UUID, taken from a [showed: ...] note in the conversation.
- preview_tag_rule {kind, value}: how many sessions a draft tag rule would match. Only as part of a tag request.

range is 24h|7d|30d|all — or an exact "<n>d"/"<n>h" when the user names a span ("last 2 days"→"2d", "past 36 hours"→"36h"). "today"→24h, "this month"→30d, "ever/all time"→all. Default 7d. Always honor the exact span the user asked for.

How to work, every time:
1. Read the new question TOGETHER WITH the conversation. Researcher lines may end with a bracketed [showed: ...] note — the segment names, session ids, figures and views that answer displayed. Resolve "it", "that", "them", "the first one" against these, copying names and ids EXACTLY.
2. Decide what evidence would answer the question, then pick the single most specific tool that fetches it. Add a second or third step only when one tool truly cannot cover the question. Broad or vague questions get overview_snapshot.
3. Choose the range the user implies. A follow-up inherits the previous question's range and filters unless the new question changes them.
4. Set from_history true (with no steps) ONLY when the conversation already contains everything needed — summarizing what you said, explaining a term you used, or pleasantries (those are intent smalltalk). Digging deeper into the data always re-queries.
5. A tag request → intent tag: fill tag_draft AND add a preview_tag_rule step. That is the only write-adjacent thing you ever plan.
6. Questions outside this data (revenue, marketing spend, code) still get the nearest in-domain step — never an empty plan.`;

/** Validate + clamp whatever came back into a safe ResearchPlan. */
export function validatePlan(raw: unknown): ResearchPlan | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const intent = typeof o.intent === 'string' && (PLAN_INTENTS as readonly string[]).includes(o.intent) ? o.intent : 'overview';
  const fromHistory = o.from_history === true;
  const stepsRaw = Array.isArray(o.steps) ? o.steps : [];
  const steps: ResearchPlan['steps'] = [];
  for (const s of stepsRaw.slice(0, 3)) {
    if (!s || typeof s !== 'object') continue;
    const t = (s as Record<string, unknown>).tool;
    if (typeof t !== 'string' || !TOOLS[t]) continue;
    const args = (s as Record<string, unknown>).args;
    steps.push({ tool: t, args: args && typeof args === 'object' ? args as Record<string, unknown> : {} });
  }
  let tagDraft: ResearchPlan['tagDraft'] = null;
  const td = o.tag_draft;
  if (td && typeof td === 'object') {
    const d = td as Record<string, unknown>;
    if (
      typeof d.name === 'string' && d.name.trim() &&
      (d.kind === 'url_contains' || d.kind === 'session_count_gte') &&
      typeof d.value === 'string' && d.value.trim()
    ) {
      tagDraft = {
        name: d.name.trim().slice(0, 60),
        kind: d.kind,
        value: d.value.trim(),
        color: typeof d.color === 'string' && ['green', 'blue', 'purple', 'amber', 'red', 'gray'].includes(d.color) ? d.color : 'blue',
      };
    }
  }
  // Never-dead-end rule 1: something always grounds the answer.
  if (steps.length === 0 && !fromHistory && intent !== 'smalltalk') steps.push(floorStep());
  return { intent, fromHistory, steps, tagDraft };
}

const RANGE_HINTS: [RegExp, string][] = [
  [/\btoday|last 24|24 ?h|past day\b/i, '24h'],
  [/\bthis month|30 ?d|last month|past month\b/i, '30d'],
  [/\ball.?time|ever|overall|total history|since the (start|beginning)\b/i, 'all'],
];

/** Exact spans first ("last 2 days" → "2d"), then the coarse hints. */
export function rangeFromWords(question: string): string | null {
  const days = question.match(/(?:last|past|previous)\s+(\d{1,2})\s*days?/i)?.[1];
  if (days) {
    const n = parseInt(days, 10);
    return n === 1 ? '24h' : n === 7 ? '7d' : n === 30 ? '30d' : `${n}d`;
  }
  const hours = question.match(/(?:last|past|previous)\s+(\d{1,2})\s*hours?/i)?.[1];
  if (hours) {
    const n = parseInt(hours, 10);
    return n === 24 ? '24h' : `${n}h`;
  }
  if (/couple of days/i.test(question)) return '2d';
  return RANGE_HINTS.find(([re]) => re.test(question.toLowerCase()))?.[1] ?? null;
}

/** Keyword fallback — used when no LLM is configured or both calls fail.
 * Deliberately generous: some plan always comes out. */
export function heuristicPlan(question: string): ResearchPlan {
  const q = question.toLowerCase();
  const range = rangeFromWords(question) ?? '7d';
  const args: Record<string, unknown> = { range };

  const tagMatch = q.match(/\btag\b/);
  if (tagMatch) {
    const quoted = question.match(/["'“”]([^"'“”]{2,40})["'“”]/)?.[1];
    const pathWord = q.match(/\b(?:visited|on|containing|contains|path|page|url)\s+["'“”]?([a-z0-9/_.-]{2,40})/i)?.[1];
    const value = quoted || pathWord || '';
    if (value) {
      return {
        intent: 'tag', fromHistory: false,
        steps: [{ tool: 'preview_tag_rule', args: { kind: 'url_contains', value } }],
        tagDraft: { name: `${value.replace(/^\//, '')} visitors`.slice(0, 60), kind: 'url_contains', value, color: 'blue' },
      };
    }
  }
  if (/\bsegment|cluster|persona|kinds? of (visitor|user)/i.test(q)) {
    const named = question.match(/["'“”]([^"'“”]{3,50})["'“”]/)?.[1]
      ?? question.match(/\b(?:about|the)\s+(?:the\s+)?([A-Z][\w-]+(?:\s+[A-Z][\w-]+){0,4})\s+segment/)?.[1];
    const cArgs: Record<string, unknown> = {};
    if (named) cArgs.segment = named;
    // Clusters default to all-time; a window applies only when asked for.
    if (/\btoday|yesterday|last|past|this (week|month)|recent|\bdays?\b|hours?\b/i.test(q)) {
      cArgs.range = rangeFromWords(question) ?? '7d';
    }
    return { intent: 'clusters', fromHistory: false, steps: [{ tool: 'get_clusters', args: cArgs }], tagDraft: null };
  }
  if (/\bwho\b|visitor|most (engaged|active)|returning users?\b/i.test(q)) {
    return { intent: 'visitors', fromHistory: false, steps: [{ tool: 'query_visitors', args: { range, sort: /time|engaged/.test(q) ? 'time' : 'sessions' } }], tagDraft: null };
  }
  if (/session|watch|replay|recording|frustrat|rage|struggl/i.test(q)) {
    if (/frustrat|rage|struggl|friction|angry/.test(q)) args.frustratedOnly = true;
    if (/mobile|phone/.test(q)) args.device = 'mobile';
    if (/desktop/.test(q)) args.device = 'desktop';
    if (/\bnew (visitor|user)/.test(q)) args.newOnly = true;
    if (/longest|deep/.test(q)) args.sort = 'longest';
    return { intent: 'sessions', fromHistory: false, steps: [{ tool: 'query_sessions', args }], tagDraft: null };
  }
  if (/trend|timeline|traffic|source|referr|countr|device|browser|peak|growing|drop|friction|conver/i.test(q)) {
    const focus = /source|traffic|referr|from/.test(q) ? 'sources'
      : /friction|frustrat/.test(q) ? 'friction'
      : /countr/.test(q) ? 'countries'
      : /device|mobile|desktop/.test(q) ? 'devices'
      : /browser/.test(q) ? 'browsers'
      : /entry|land/.test(q) ? 'entries'
      : undefined;
    return { intent: 'timeline', fromHistory: false, steps: [{ tool: 'get_timeline', args: focus ? { range, focus } : { range } }], tagDraft: null };
  }
  return { intent: 'overview', fromHistory: false, steps: [{ tool: 'overview_snapshot', args: { range } }], tagDraft: null };
}

/**
 * Produce the plan: LLM (grammar-forced, one repair retry) → heuristic.
 * historyBrief is a compact rendering of the last few turns so follow-ups
 * route correctly.
 */
export async function routeQuestion(question: string, historyBrief: string, fetchFn: typeof fetch = fetch): Promise<{ plan: ResearchPlan; via: 'llm' | 'heuristic' }> {
  const user = historyBrief
    ? `Conversation so far:\n${historyBrief}\n\nNew question: ${question}`
    : `Question: ${question}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const text = await llmChatJson({
        system: ROUTER_SYSTEM,
        user: attempt === 0 ? user : `${user}\n\n(Your previous plan was invalid — return a corrected plan.)`,
        schema: PLAN_SCHEMA,
        maxTokens: 300,
        timeoutMs: 25_000,
        fetchFn,
      });
      if (text === null) break; // no LLM configured
      const plan = validatePlan(JSON.parse(text));
      if (plan) return { plan, via: 'llm' };
    } catch {
      // fall through to retry / heuristic
    }
  }
  return { plan: heuristicPlan(question), via: 'heuristic' };
}
