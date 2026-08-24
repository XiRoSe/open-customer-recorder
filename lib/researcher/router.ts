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
export const ROUTER_SYSTEM = `You translate an analytics question into a JSON research plan. You never answer the question yourself — you only pick tools.

The product records website visitor sessions (replays) and derives: AI session summaries, visitor profiles, behavioral segments (clusters), an hourly timeline, and admin-defined tags.

Tools (pick at most 3 steps, usually 1):
- overview_snapshot {range}: headline numbers, needs-attention callouts, noteworthy sessions, top segments. The safe default.
- get_timeline {range, focus?}: totals + trends vs previous window. focus one of sources|devices|browsers|countries|referrers|entries|friction.
- query_sessions {range?, user?, tag?, device?, source?, country?, browser?, path?, minSeconds?, frustratedOnly?, newOnly?, sort?, limit?}: concrete sessions to watch. sort one of recent|longest|most_pages. device one of mobile|tablet|desktop. source one of search|referral|ads|social|internal|direct.
- query_visitors {range?, sort?, limit?}: visitors grouped with totals + AI profiles. sort one of sessions|time|recent.
- get_clusters {dimension?, segment?, range?}: behavioral segments. dimension one of overall|persona|intent|source|experience. segment = a segment name from the question, to spotlight it on the cluster map. range filters to members ACTIVE in that window (omit for all-time).
- session_digest {sessionId}: everything about one session (needs a UUID from history).
- preview_tag_rule {kind, value}: how many sessions a draft tag rule would match.

range is one of 24h|7d|30d|all — OR a custom window when the question names an exact span: "<n>d" for days, "<n>h" for hours ("last 2 days"→"2d", "past 36 hours"→"36h"). Default 7d; "today"→24h, "this month"→30d, "ever/all time"→all. Always honor the exact span the user asked for.

Rules:
- Always produce at least one step, unless from_history is true (the conversation already contains the answer) or intent is smalltalk.
- Questions outside the data (revenue, marketing spend, code) still get the nearest in-domain step — e.g. revenue→query_sessions on the pricing path.
- intent tag → fill tag_draft AND include a preview_tag_rule step. Never any other write.
- Prefer the specific tool over overview_snapshot when the question names sessions, visitors, segments, trends, or a filter.

Examples:
Q: "how are we doing this week?"
{"intent":"overview","from_history":false,"steps":[{"tool":"overview_snapshot","args":{"range":"7d"}}],"tag_draft":null}
Q: "show me frustrated mobile sessions from today"
{"intent":"sessions","from_history":false,"steps":[{"tool":"query_sessions","args":{"range":"24h","device":"mobile","frustratedOnly":true}}],"tag_draft":null}
Q: "where does our traffic come from and is it growing?"
{"intent":"timeline","from_history":false,"steps":[{"tool":"get_timeline","args":{"range":"30d","focus":"sources"}}],"tag_draft":null}
Q: "who are our most engaged users?"
{"intent":"visitors","from_history":false,"steps":[{"tool":"query_visitors","args":{"range":"30d","sort":"time"}}],"tag_draft":null}
Q: "what kinds of visitors do we have?"
{"intent":"clusters","from_history":false,"steps":[{"tool":"get_clusters","args":{"dimension":"overall"}}],"tag_draft":null}
Q: "tell me about the Frantic Integrators segment"
{"intent":"clusters","from_history":false,"steps":[{"tool":"get_clusters","args":{"segment":"Frantic Integrators"}}],"tag_draft":null}
Q: "how many users were clustered in the last 2 days?"
{"intent":"clusters","from_history":false,"steps":[{"tool":"get_clusters","args":{"range":"2d"}}],"tag_draft":null}
Q: "what was the timeline for the last 2 days?"
{"intent":"timeline","from_history":false,"steps":[{"tool":"get_timeline","args":{"range":"2d"}}],"tag_draft":null}
Q: "tag everyone who visited pricing"
{"intent":"tag","from_history":false,"steps":[{"tool":"preview_tag_rule","args":{"kind":"url_contains","value":"pricing"}}],"tag_draft":{"name":"Pricing visitors","kind":"url_contains","value":"pricing","color":"blue"}}
Q: "and on mobile?" (after a sessions question)
{"intent":"followup","from_history":false,"steps":[{"tool":"query_sessions","args":{"range":"7d","device":"mobile"}}],"tag_draft":null}
Q: "thanks!"
{"intent":"smalltalk","from_history":true,"steps":[],"tag_draft":null}`;

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
