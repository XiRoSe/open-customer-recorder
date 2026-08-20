// Dumps (digest -> intentText) pairs as chat-format JSONL for LoRA
// fine-tuning. Usage: DATABASE_URL=... node scripts/export-training-data.mjs > train.jsonl
import postgres from 'postgres';

// Keep byte-identical to lib/summary-worker.ts — training must match inference.
const SYSTEM_PROMPT = `You analyze a website visitor's session digest (JSON: steps the visitor took, frustration signals, timing stats). Screenshots of key replay moments may be attached - mention visible layout or content problems only if they are clearly relevant.
Write 2-3 plain sentences: what the visitor was likely trying to do, and any friction they hit.
Only state what the data supports. No markdown, no preamble, no bullet points.`;

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
      { role: 'user', content: JSON.stringify(r.digest) },
      { role: 'assistant', content: r.intent_text },
    ],
  }) + '\n');
}
console.error(`exported ${rows.length} pairs`);
await sql.end();
