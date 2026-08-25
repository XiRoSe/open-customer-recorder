#!/usr/bin/env node
/**
 * Researcher routing eval — golden questions against the LIVE endpoint.
 *
 * Every prompt change gets measured here instead of eyeballed. Cases are
 * deliberately NOT phrased like the prompt's own vocabulary: paraphrases,
 * indirection, pronouns, multi-turn chains, and out-of-domain asks — the
 * point is to test generalization, not recall.
 *
 * Usage:
 *   RESEARCHER_EVAL_TOKEN=<ps_session jwt> node scripts/researcher-eval.mjs \
 *     [--base https://www.pocketscience.ai] [--project <uuid>] [--only <substr>]
 *
 * Mint a token on the server (secret never leaves the box):
 *   railway ssh --service app -- node -e "<see docs: HMAC-sign the session
 *   payload from admin_users with process.env.JWT_SECRET>"
 *
 * Assertions per case (all optional):
 *   toolsAny:   [[...]] — at least one listed tool-set must be a subset of
 *               the tools that actually ran (sets allow "either tool is a
 *               reasonable reading" cases)
 *   forbid:     tools that must NOT run
 *   noTools:    true — no research tool may run (smalltalk / from_history)
 *   citation:   substrings that must appear in some citation detail
 *   answerNot:  substrings that must NOT appear in the final answer text
 * Multi-turn: `turns` chains questions through one thread; assertions can
 * reference ids captured from an earlier turn via {fromShownId: n}.
 */

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const BASE = flag('base', 'https://www.pocketscience.ai');
const ONLY = flag('only', '');
const TOKEN = process.env.RESEARCHER_EVAL_TOKEN;
if (!TOKEN) {
  console.error('RESEARCHER_EVAL_TOKEN is required (a valid ps_session JWT).');
  process.exit(1);
}

// Research tools (excludes the route/compose bookkeeping footprints).
const RESEARCH_TOOLS = new Set([
  'overview_snapshot', 'get_timeline', 'query_sessions', 'query_visitors',
  'get_clusters', 'session_digest', 'preview_tag_rule',
]);

const CASES = [
  // --- single turn: vague, indirect, oddly-phrased ---
  { name: 'vague + yesterday', q: 'did anything weird happen yesterday?',
    toolsAny: [['overview_snapshot'], ['get_timeline'], ['query_sessions']] },
  { name: 'indirect docs engagement', q: 'are people actually reading the docs or just bouncing?',
    toolsAny: [['query_sessions'], ['get_timeline']] },
  { name: 'comparison phrasing', q: 'compare this week to the one before it',
    toolsAny: [['get_timeline'], ['overview_snapshot']] },
  { name: 'why-question -> friction', q: 'why are mobile users struggling?',
    toolsAny: [['query_sessions'], ['get_timeline']] },
  { name: 'localization decision', q: 'which country should we localize for first?',
    toolsAny: [['get_timeline'], ['overview_snapshot'], ['query_visitors']] },
  { name: 'needle: search visitor, long, yesterday', q: 'someone who found us on google spent ages here yesterday - find them',
    toolsAny: [['query_sessions']] },
  { name: 'stickiness paraphrase', q: 'how sticky are we?',
    toolsAny: [['query_visitors'], ['overview_snapshot'], ['get_timeline']] },
  { name: 'power users paraphrase', q: 'what do our power users look like?',
    toolsAny: [['query_visitors'], ['get_clusters']] },
  { name: 'tag via "label"', q: 'label everyone who reached checkout',
    toolsAny: [['preview_tag_rule']] },
  { name: 'out-of-domain: revenue', q: 'how much money did we make this week?',
    toolsAny: [['query_sessions'], ['overview_snapshot'], ['get_timeline']],
    answerNot: ['revenue was', 'we made $'] },
  { name: 'monthly change', q: 'what changed since last month?',
    toolsAny: [['get_timeline'], ['overview_snapshot']] },
  { name: 'landing page working?', q: 'is our new landing page working?',
    toolsAny: [['get_timeline'], ['query_sessions'], ['overview_snapshot']] },
  { name: 'browser split, yesterday', q: "show me yesterday's traffic split by browser",
    toolsAny: [['get_timeline']] },
  { name: 'duration filter, month', q: 'find sessions longer than 5 minutes from this month',
    toolsAny: [['query_sessions']] },
  { name: 'smalltalk', q: "thanks, that's really helpful!", noTools: true },

  // --- multi-turn: inheritance + reference resolution ---
  {
    name: 'inherit range+filter, add device',
    turns: [
      { q: 'show me frustrated sessions from the past 3 days', toolsAny: [['query_sessions']] },
      { q: 'only the ones on mobile', toolsAny: [['query_sessions']], citation: ['3 day'] },
    ],
  },
  {
    name: 'ordinal session reference',
    turns: [
      { q: 'what are the longest sessions this week?', toolsAny: [['query_sessions']], captureIds: true },
      { q: 'open the second one', toolsAny: [['session_digest']], citationShownId: 1 },
    ],
  },
  {
    name: 'segment reference by description',
    turns: [
      { q: 'what kinds of visitors do we have?', toolsAny: [['get_clusters']] },
      { q: 'tell me more about the biggest group', toolsAny: [['get_clusters']], citation: ['spotlight'] },
    ],
  },
  {
    name: 'meta question about own answer',
    turns: [
      { q: 'how are we doing this week?', toolsAny: [['overview_snapshot']] },
      { q: 'what did you mean by engaged?', noTools: true },
    ],
  },
];

function parseSse(text) {
  const events = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    try { events.push(JSON.parse(line.slice(6))); } catch { /* partial */ }
  }
  return events;
}

async function ask(question, threadId) {
  const res = await fetch(`${BASE}/api/admin/projects/${PROJECT}/researcher`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: `ps_session=${TOKEN}` },
    body: JSON.stringify({ question, threadId }),
  });
  const text = await res.text();
  const events = parseSse(text);
  const done = events.find((e) => e.type === 'done');
  const tools = events.filter((e) => e.type === 'tool' && e.status !== 'start' && RESEARCH_TOOLS.has(e.name)).map((e) => e.name);
  const citations = done?.payload?.citations?.map((c) => `${c.label} ${c.detail}`) ?? [];
  const shownIds = (done?.payload?.blocks ?? [])
    .filter((b) => b.type === 'sessions')
    .flatMap((b) => b.items.map((i) => i.id));
  return {
    threadId: events.find((e) => e.type === 'meta')?.threadId ?? threadId,
    tools: [...new Set(tools)],
    citations,
    shownIds,
    answer: done?.content ?? '',
    ok: !!done,
  };
}

function judge(spec, out, captured) {
  const fails = [];
  if (!out.ok) fails.push('stream ended without done');
  if (spec.noTools && out.tools.length > 0) fails.push(`expected no tools, ran: ${out.tools.join(',')}`);
  if (spec.toolsAny) {
    const hit = spec.toolsAny.some((set) => set.every((t) => out.tools.includes(t)));
    if (!hit) fails.push(`tools ${JSON.stringify(out.tools)} matched none of ${JSON.stringify(spec.toolsAny)}`);
  }
  if (spec.forbid) {
    for (const t of spec.forbid) if (out.tools.includes(t)) fails.push(`forbidden tool ran: ${t}`);
  }
  if (spec.citation) {
    for (const s of spec.citation) {
      if (!out.citations.some((c) => c.toLowerCase().includes(s.toLowerCase()))) {
        fails.push(`no citation contains "${s}" (got: ${out.citations.join(' | ') || 'none'})`);
      }
    }
  }
  if (spec.citationShownId != null) {
    const id = captured[spec.citationShownId];
    const idShort = id ? id.slice(0, 8) : '';
    if (!id) fails.push(`no captured id at index ${spec.citationShownId}`);
    else if (!out.citations.some((c) => c.includes(idShort)) && !out.answer.includes(idShort)) {
      fails.push(`neither citations nor answer reference captured id ${idShort}…`);
    }
  }
  if (spec.answerNot) {
    for (const s of spec.answerNot) {
      if (out.answer.toLowerCase().includes(s.toLowerCase())) fails.push(`answer contains forbidden "${s}"`);
    }
  }
  return fails;
}

let PROJECT = flag('project', '');
if (!PROJECT) {
  const res = await fetch(`${BASE}/api/admin/projects`, { headers: { cookie: `ps_session=${TOKEN}` } });
  PROJECT = (await res.json()).projects[0].id;
}

const results = [];
for (const c of CASES) {
  if (ONLY && !c.name.includes(ONLY)) continue;
  const turns = c.turns ?? [{ ...c }];
  let threadId = undefined;
  let captured = [];
  const caseFails = [];
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    let out;
    try {
      out = await ask(t.q, threadId);
    } catch (e) {
      caseFails.push(`turn ${i + 1} threw: ${e.message}`);
      break;
    }
    threadId = out.threadId;
    if (t.captureIds) captured = out.shownIds;
    const fails = judge(t, out, captured);
    for (const f of fails) caseFails.push(`turn ${i + 1}: ${f} [tools: ${out.tools.join(',') || 'none'}]`);
  }
  const pass = caseFails.length === 0;
  results.push({ name: c.name, pass, fails: caseFails });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${c.name}${pass ? '' : '\n      ' + caseFails.join('\n      ')}`);
}

const passed = results.filter((r) => r.pass).length;
console.log(`\n${passed}/${results.length} passed (${Math.round((passed / results.length) * 100)}%)`);
process.exit(passed === results.length ? 0 : 1);
