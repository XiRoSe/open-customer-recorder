// Early-warning gauges for the Settings → Infra section: queue depths,
// summary latency, database and blob size, rollup coverage. Cheap
// aggregate reads — the point is to see strain long before users do.
import { sql } from 'drizzle-orm';
import { db, schema } from '@/lib/db';
import { queuesEnabled, queueDepths, type QueueName } from './queue';
import { llmBaseUrl } from './llm-service';

export interface InfraStats {
  queuesEnabled: boolean;
  llmConfigured: boolean;
  queues: Record<QueueName, { waiting: number; active: number; failed: number }> | null;
  summaries: { pending: number; processing: number; failed: number; done: number };
  medianLatencyMs: number | null;   // done in the last 24h
  dbBytes: number;
  blobBytes: number;
  rollups: { count: number; freshestHour: Date | null };
}

export async function infraStats(): Promise<InfraStats> {
  interface Row extends Record<string, unknown> {
    pending: number; processing: number; failed: number; done: number;
    median_ms: number | null; db_bytes: string; blob_bytes: string | null;
    rollup_count: number; rollup_freshest: string | null;
  }
  const res = await db.execute<Row>(sql`
    SELECT
      (SELECT count(*)::int FROM ${schema.sessionSummaries} WHERE status = 'pending') AS pending,
      (SELECT count(*)::int FROM ${schema.sessionSummaries} WHERE status = 'processing') AS processing,
      (SELECT count(*)::int FROM ${schema.sessionSummaries} WHERE status = 'failed') AS failed,
      (SELECT count(*)::int FROM ${schema.sessionSummaries} WHERE status = 'done') AS done,
      (SELECT (percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (updated_at - created_at)))) * 1000
       FROM ${schema.sessionSummaries}
       WHERE status = 'done' AND updated_at > now() - interval '24 hours') AS median_ms,
      pg_database_size(current_database()) AS db_bytes,
      (SELECT sum(blob_bytes) FROM ${schema.sessions}) AS blob_bytes,
      (SELECT count(*)::int FROM ${schema.timelineRollups}) AS rollup_count,
      (SELECT max(hour_start)::text FROM ${schema.timelineRollups}) AS rollup_freshest
  `);
  const rows: Row[] = Array.isArray(res) ? res : (res as unknown as { rows: Row[] }).rows ?? [];
  const r = rows[0];

  const queues = await queueDepths().catch((e) => {
    console.warn('[infra] queue depths unavailable', e instanceof Error ? e.message : e);
    return null;
  });

  return {
    queuesEnabled: queuesEnabled(),
    llmConfigured: Boolean(llmBaseUrl()),
    queues,
    summaries: { pending: r.pending, processing: r.processing, failed: r.failed, done: r.done },
    medianLatencyMs: r.median_ms === null ? null : Number(r.median_ms),
    dbBytes: Number(r.db_bytes),
    blobBytes: Number(r.blob_bytes ?? 0),
    rollups: { count: r.rollup_count, freshestHour: r.rollup_freshest ? new Date(r.rollup_freshest) : null },
  };
}
