// Dumps (digest -> intentText) pairs as chat-format JSONL for LoRA
// fine-tuning. Usage: DATABASE_URL=... node scripts/export-training-data.mjs > train.jsonl
import postgres from 'postgres';

// Keep byte-identical to lib/summary-worker.ts — training must match inference.
const SYSTEM_PROMPT = `You analyze a website visitor's session activity log (steps the visitor took, frustration signals, timing stats). Screenshots of key replay moments may be attached - mention visible layout or content problems only if they are clearly relevant.
Write 2-3 plain sentences: what the visitor was likely trying to do, and any friction they hit.
Only state what the data supports. No markdown, no preamble, no bullet points.`;

// Mirror of compactDigest in lib/session-digest.ts — keep in sync.
function mss(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
function compactDigest(digest) {
  const d = digest;
  if (!d || !Array.isArray(d.steps) || d.steps.length === 0) return JSON.stringify(digest);
  const t0 = d.steps[0].t;
  const secs = (ms) => `${Math.round(ms / 1000)}s`;
  const pathOf = (url, withHost) => {
    try { const u = new URL(url); return (withHost ? u.host : '') + (u.pathname || '/'); } catch { return url; }
  };
  const lines = [];
  lines.push(`duration ${secs(d.stats?.durationMs ?? 0)} (active ${secs(d.stats?.activeMs ?? 0)}), ${d.stats?.clickCount ?? 0} clicks`);
  const pages = (d.stats?.pages ?? [])
    .map((p) => `${pathOf(p.url, false)} ${secs(p.ms)}${p.maxScrollY ? ` scroll ${p.maxScrollY}px` : ''}`)
    .join(', ');
  if (pages) lines.push(`pages: ${pages}`);
  lines.push('steps:');
  for (const s of d.steps) {
    const at = mss(s.t - t0);
    if (s.kind === 'nav') lines.push(`${at} nav ${pathOf(s.url, true)}`);
    else if (s.kind === 'click') lines.push(`${at} click "${s.label}"`);
    else if (s.kind === 'input') lines.push(`${at} typed-in ${s.field}`);
    else if (s.ms > 0) lines.push(`${at} idle ${secs(s.ms)}`);
  }
  if (d.insights?.length) {
    lines.push('signals: ' + d.insights
      .map((i) => `${i.kind}${i.count ? ` x${i.count}` : ''}${i.detail ? ` (${i.detail})` : ''}${i.at > 0 ? ` @${mss(i.at - t0)}` : ''}`)
      .join('; '));
  }
  return lines.join('\n');
}

const sql = postgres(process.env.DATABASE_URL);
const rows = await sql`
  SELECT digest, intent_text FROM session_summaries
  WHERE status = 'done' AND intent_text IS NOT NULL
  ORDER BY created_at
`;
for (const r of rows) {
  process.stdout.write(JSON.stringify({
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: compactDigest(r.digest) },
      { role: 'assistant', content: r.intent_text },
    ],
  }) + '\n');
}
console.error(`exported ${rows.length} pairs`);
await sql.end();
