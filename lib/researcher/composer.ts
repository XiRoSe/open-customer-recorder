// The composer: second (and last) LLM call — streams short analyst prose
// over the executor's compacted facts. Every number it sees came from a
// query; the blocks beside the prose always carry the exact figures, so
// a fumbled digit in prose can't mislead. When the LLM is missing or
// slow, a deterministic sentence ships instead — data on time beats
// prose late.
import { llmChatStream } from '@/lib/llm-service';
import type { ResearchPlan } from './types';
import type { ToolOutcome } from './tools';

export const COMPOSER_SYSTEM = `You are the Researcher — a sharp, warm product analyst inside a session-replay dashboard, talking to the site's admin.

Rules:
- Open with the single most useful takeaway, then 1–4 short supporting sentences. Plain text, no markdown, no bullet lists, no headers.
- Use ONLY numbers that appear in the DATA JSON. Never invent or extrapolate figures.
- The user already sees charts/tables for this data — don't enumerate every row; interpret instead.
- If DATA notes a caveat, weave one honest clause in (e.g. "small sample, though").
- If the question asked for something the data can't show, say what the nearest available signal shows and name one concrete next step. Never a bare "I can't".
- If a tag draft is present, mention it ends with the admin applying it — you only drafted it.
- Maximum ~120 words.`;

export function composerInput(question: string, plan: ResearchPlan, outcomes: ToolOutcome[], historyBrief: string): string {
  const facts = outcomes.map((o, i) => ({ step: i + 1, source: o.citation.detail, ...o.facts }));
  const caveats = outcomes.map((o) => o.caveat).filter(Boolean);
  return [
    historyBrief ? `Conversation so far:\n${historyBrief}\n` : '',
    `Question: ${question}`,
    `Intent: ${plan.intent}`,
    plan.tagDraft ? `Tag draft prepared: ${JSON.stringify(plan.tagDraft)}` : '',
    `DATA: ${JSON.stringify(facts)}`,
    caveats.length ? `Caveats: ${caveats.join(' | ')}` : '',
  ].filter(Boolean).join('\n');
}

/** Deterministic floor when no LLM is available or it ran out of time. */
export function templateAnswer(plan: ResearchPlan, outcomes: ToolOutcome[]): string {
  const first = outcomes[0];
  if (!first) return 'Here is what I could pull together — see the details below.';
  const f = first.facts as Record<string, unknown>;
  const bits: string[] = [];
  if (typeof f.sessions === 'number') bits.push(`${f.sessions} sessions`);
  if (typeof f.engaged === 'number') bits.push(`${f.engaged} engaged`);
  if (typeof f.frustrated === 'number') bits.push(`${f.frustrated} with friction`);
  if (typeof f.matched === 'number') bits.push(`${f.matched} matching sessions`);
  if (typeof f.matched === 'string') bits.push(`${f.matched} matching sessions`);
  const head = bits.length > 0
    ? `Here's the picture: ${bits.join(', ')}.`
    : 'Here is what the data shows.';
  const caveat = outcomes.map((o) => o.caveat).find(Boolean);
  return [head, 'The breakdown below has the exact figures.', caveat ? `Note: ${caveat}` : '']
    .filter(Boolean).join(' ');
}

export async function composeAnswer(opts: {
  question: string;
  plan: ResearchPlan;
  outcomes: ToolOutcome[];
  historyBrief: string;
  onToken: (t: string) => void;
  signal?: AbortSignal;
  fetchFn?: typeof fetch;
}): Promise<string> {
  const { question, plan, outcomes, historyBrief, onToken, signal, fetchFn } = opts;
  try {
    const text = await llmChatStream({
      system: COMPOSER_SYSTEM,
      user: composerInput(question, plan, outcomes, historyBrief),
      maxTokens: 700,
      timeoutMs: 60_000,
      onToken,
      signal,
      fetchFn,
    });
    if (text) return text;
  } catch (e) {
    if (signal?.aborted) throw e;
    // fall through to the template
  }
  const fallback = templateAnswer(plan, outcomes);
  onToken(fallback);
  return fallback;
}

/** Grounded follow-up chips, by intent — each one is a real question the
 * router can answer, so a tap never dead-ends. */
export function followupsFor(plan: ResearchPlan, outcomes: ToolOutcome[]): string[] {
  const hasFriction = outcomes.some((o) => {
    const f = o.facts as Record<string, unknown>;
    return (typeof f.frustrated === 'number' && f.frustrated > 0);
  });
  const byIntent: Record<string, string[]> = {
    overview: ['Which sessions had friction this week?', 'Where is traffic coming from?', 'Who are the most engaged visitors?'],
    timeline: ['Show me sessions behind the biggest spike', 'How does this compare to all time?', 'Which entry pages see the most friction?'],
    sessions: ['What do these visitors have in common?', 'Show the longest of these sessions', 'Tag sessions like these'],
    visitors: ['What segments do these visitors fall into?', 'Show me the newest visitors', 'Which visitors hit friction?'],
    clusters: ['Show sessions from the biggest segment', 'How do the persona segments differ?', 'Which segment is growing?'],
    session_detail: ['Show more sessions like this one', 'Did this visitor come back?', 'What friction did this session hit?'],
    tag: ['Show sessions this tag would match', 'What tags exist already?', 'How many sessions got tagged this week?'],
    followup: ['Zoom out to the full picture', 'Show me the sessions behind this', 'Compare with the previous period'],
    smalltalk: ['How are we doing this week?', 'Any friction I should look at?', 'Who are our top visitors?'],
  };
  const chips = byIntent[plan.intent] ?? byIntent.overview;
  return (hasFriction && plan.intent !== 'sessions'
    ? ['Show me the frustrated sessions', ...chips]
    : chips
  ).slice(0, 3);
}
