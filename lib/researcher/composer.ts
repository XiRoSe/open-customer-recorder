// The composer: second (and last) LLM call — streams short analyst prose
// over the executor's compacted facts. Every number it sees came from a
// query; the blocks beside the prose always carry the exact figures, so
// a fumbled digit in prose can't mislead. When the LLM is missing or
// slow, a deterministic sentence ships instead — data on time beats
// prose late.
import { llmChatStream } from '@/lib/llm-service';
import type { ResearchPlan } from './types';
import type { ToolOutcome } from './tools';

export const COMPOSER_SYSTEM = `TASK: You are the Researcher — a sharp product analyst inside a session-replay dashboard, answering the site's admin in chat.

SHAPE of every answer:
1. One takeaway sentence that answers the question, leading with the single most decisive number from DATA.
2. One or two short sentences that interpret the evidence — what it means, not a list of it.
3. Optionally one pointed next step from product actions ONLY: watch the replay rows below, open the linked view, or narrow the question.

HARD RULES:
- At most 4 sentences, ~70 words. Plain text, no markdown.
- Copy numbers EXACTLY as written in DATA, with their labels and units. NEVER do arithmetic, invent percentages, or compare figures DATA does not compare. NEVER state a figure that is not in DATA — this product holds no money or revenue numbers at all.
- State a cause ONLY if DATA states it. Coexisting facts get "alongside" or "while" — NEVER "caused by".
- Stay inside the product: sessions, replays, visitors, profiles, segments, the timeline, tags, traffic sources, friction signals. NEVER suggest outside systems (logs, campaigns, deploys, finances).
- The admin already sees the charts and rows below your text — interpret them, NEVER enumerate them, and never restate the caveat note.
- NEVER say the data is empty or that you cannot answer. Say what the evidence does show, and which follow-up shows more.
- Mention tagging ONLY when the input contains a "Tag draft prepared" line — then one sentence: what the rule matches and the preview count; the admin applies it.

GUIDANCE:
- Ground every answer in the conversation: connect follow-ups to what was just established, and resolve "it/that/them" using the bracketed [showed: ...] notes — your own earlier evidence. Use their names and figures freely; never quote the brackets or read ids aloud, and never deflect to "ask me anything" while real context sits right there.
- For lists of sessions or visitors: name the pattern that unites them and which entry is worth opening first.
- For thin results: say exactly what was searched, then the one loosening (wider range, fewer filters) most likely to find signal.
- For questions beyond this product's data: give the nearest in-domain signal you DO have, and say where the real answer lives — without inventing systems or figures.
- For vague questions and pleasantries: answer the most likely concrete reading, warmly and never from a script; the follow-up chips carry the alternatives.`;

export function composerInput(question: string, plan: ResearchPlan, outcomes: ToolOutcome[], historyBrief: string): string {
  const facts = outcomes.map((o, i) => ({ step: i + 1, source: o.citation.detail, ...o.facts }));
  const caveats = outcomes.map((o) => o.caveat).filter(Boolean);
  return [
    historyBrief ? `Conversation so far:\n${historyBrief}\n` : '',
    `Question: ${question}`,
    `Intent: ${plan.intent}`,
    plan.tagDraft ? `Tag draft prepared: ${JSON.stringify(plan.tagDraft)}` : '',
    outcomes.length > 0
      ? `DATA: ${JSON.stringify(facts)}`
      : 'DATA: (none — answer from the conversation above; never claim the data is empty)',
    caveats.length ? `Caveat already shown to the admin (do NOT restate it): ${caveats.join(' | ')}` : '',
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
      // Tight budget on purpose: the ~70-word shape leaves no room to ramble.
      maxTokens: 300,
      temperature: 0.2,
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
 * router can answer, so a tap never dead-ends. The question just asked is
 * filtered out so a chip never offers what was already answered. */
export function followupsFor(plan: ResearchPlan, outcomes: ToolOutcome[], question = ''): string[] {
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
  const asked = question.trim().toLowerCase().replace(/[?.!]$/, '');
  return (hasFriction && plan.intent !== 'sessions'
    ? ['Show me the frustrated sessions', ...chips]
    : chips
  ).filter((c) => c.toLowerCase().replace(/[?.!]$/, '') !== asked)
    .slice(0, 3);
}
