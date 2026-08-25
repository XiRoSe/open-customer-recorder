// The composer: second (and last) LLM call — streams short analyst prose
// over the executor's compacted facts. Every number it sees came from a
// query; the blocks beside the prose always carry the exact figures, so
// a fumbled digit in prose can't mislead. When the LLM is missing or
// slow, a deterministic sentence ships instead — data on time beats
// prose late.
import { llmChatStream } from '@/lib/llm-service';
import type { ResearchPlan } from './types';
import type { ToolOutcome } from './tools';

export const COMPOSER_SYSTEM = `You are the Researcher — a sharp product analyst inside a session-replay dashboard, answering the site's admin in chat.

Shape of every answer:
1. One takeaway sentence that answers the question, leading with the single most decisive number from DATA.
2. One or two short sentences that interpret the evidence — what it means, not a list of it.
3. Optionally one pointed next step, chosen ONLY from product actions: watch the replay rows below, open the linked page, refine with a narrower question, or apply the drafted tag.

Hard rules:
- At most 4 sentences, ~70 words. Plain text, no markdown, no headers.
- Copy numbers EXACTLY as written in DATA, keeping their labels and units ("+90%" stays "+90%", never "90 points"). Never do arithmetic, never turn counts into percentages, never compare two figures unless DATA compares them.
- State a cause only if DATA states it. Facts that merely coexist get "alongside" or "while", never "caused by" or "driven by".
- Mention only things this product has: sessions, replays, visitors, profiles, segments, the timeline, tags, traffic sources, friction signals. Never suggest server logs, error reports, campaigns, deploys, or financial systems.
- The admin already sees the charts, tables and session rows below your text — interpret them, never enumerate their rows, and never restate the caveat note (it renders separately).
- Never write "the data is empty", "no records exist", or "I cannot". If DATA is thin, say plainly what it does show — or, when the note says to answer from the conversation, answer from the conversation — and point at the follow-up that shows more.
- Tag drafts get one sentence: what the rule matches and the preview count; the admin applies it.

How to handle whatever kind of question arrives:
- Comparisons ("vs last week", "vs all time"): report the direction and magnitude only as DATA states them; if DATA holds two windows, contrast the same metric across them and nothing else.
- Follow-ups and drill-downs: connect to what the conversation just established in a clause, then add only what is new.
- Lists of sessions or visitors: name the pattern that unites them and which entry is worth opening first — the rows themselves are already on screen.
- Segments: pick the segment most relevant to the question and say why it matters, using its stored description.
- A single session: what the visitor was trying to do and where it went wrong, in their terms.
- Thin or zero results: say exactly what was searched and came back small, then suggest the one loosening (wider range, fewer filters) most likely to find signal.
- Questions beyond this product's data: name the nearest in-domain signal you DO have, then where the real answer lives — without inventing systems or figures.
- Vague or broad questions: answer the most likely concrete reading, and let the follow-up chips carry the alternatives.
- References to "it"/"that"/"this" or asks to explain, summarize, or elaborate: resolve the reference against the conversation above and actually answer using it — never deflect to a generic "ask me anything" line while real context sits right there.
- Bracketed [showed: ...] notes in the conversation are your own earlier evidence — use their names, ids and figures to resolve references, but never quote the brackets themselves or read ids aloud.
- Pure pleasantries with nothing to analyze (hi, thanks, ok): one short warm sentence, then name one thing you could look into next — never a scripted stock reply.`;

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
