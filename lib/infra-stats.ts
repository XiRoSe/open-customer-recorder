// Early-warning gauges for the Settings → Infra section: queue depths,
// summary latency, database and blob size, rollup coverage. Cheap
// aggregate reads — the point is to see strain long before users do.
import { sql } from 'drizzle-orm';
import { db, schema } from '@/lib/db';
import { queuesEnabled, queueDepths, getQueue, type QueueName } from './queue';
import { llmBaseUrl } from './llm-service';

export interface InfraStats {
  queuesEnabled: boolean;
  /** 'connected' = /health answered; 'unreachable' = configured but down. */
  llm: 'connected' | 'unreachable' | 'not set';
  /** Live BullMQ workers holding the clustering queue (the standalone
   * cluster service). null when queues are off. */
  clusterWorkers: number | null;
  queues: Record<QueueName, { waiting: number; active: number }> | null;
  summaries: { pending: number; processing: number; failed: number; done: number };
  medianLatencyMs: number | null;   // done in the last 24h
  dbBytes: number;
  /** Total size of the sessions relation incl. TOAST — where the replay
   * blobs actually live. O(1) catalog read, no table scan. */
  sessionsBytes: number;
  rollups: { count: number; freshestHour: Date | null };
  /** Researcher usage: answered questions in the last 24h + the median
   * end-to-end run time (summed step timings from the footprints). */
  researcher: { questions24h: number; medianRunMs: number | null };
}

async function llmHealth(): Promise<'connected' | 'unreachable' | 'not set'> {
  const base = llmBaseUrl();
  if (!base) return 'not set';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 3_000);
  try {
    const res = await fetch(`${base.replace(/\/$/, '')}/health`, { signal: ctrl.signal });
    return res.ok ? 'connected' : 'unreachable';
  } catch {
    return 'unreachable';
  } finally {
    clearTimeout(timer);
  }
}

async function clusterWorkerCount(): Promise<number | null> {
  const q = getQueue('clustering');
  if (!q) return null;
  try {
    return (await q.getWorkers()).length;
  } catch (e) {
    console.warn('[infra] cluster worker check failed', e instanceof Error ? e.message : e);
    return null;
  }
}

export async function infraStats(): Promise<InfraStats> {
  interface Row extends Record<string, unknown> {
    pending: number; processing: number; failed: number; done: number;
    median_ms: number | null; db_bytes: string; sessions_bytes: string;
    rollup_count: number; rollup_freshest: string | null;
    researcher_answers: number; researcher_median_ms: number | null;
  }
  const res = await db.execute<Row>(sql`
    WITH s AS (
      SELECT status, count(*)::int AS n FROM ${schema.sessionSummaries} GROUP BY status
    )
    SELECT
      coalesce((SELECT n FROM s WHERE status = 'pending'), 0) AS pending,
      coalesce((SELECT n FROM s WHERE status = 'processing'), 0) AS processing,
      coalesce((SELECT n FROM s WHERE status = 'failed'), 0) AS failed,
      coalesce((SELECT n FROM s WHERE status = 'done'), 0) AS done,
      (SELECT (percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (updated_at - created_at)))) * 1000
       FROM ${schema.sessionSummaries}
       WHERE status = 'done' AND updated_at > now() - interval '24 hours') AS median_ms,
      pg_database_size(current_database()) AS db_bytes,
      pg_total_relation_size('sessions') AS sessions_bytes,
      (SELECT count(*)::int FROM ${schema.timelineRollups}) AS rollup_count,
      (SELECT max(hour_start)::text FROM ${schema.timelineRollups}) AS rollup_freshest,
      (SELECT count(*)::int FROM ${schema.researcherMessages}
       WHERE role = 'assistant' AND created_at > now() - interval '24 hours') AS researcher_answers,
      (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY total_ms) FROM (
        SELECT (SELECT sum((f->>'ms')::bigint) FROM jsonb_array_elements(payload->'footprints') f) AS total_ms
        FROM ${schema.researcherMessages}
        WHERE role = 'assistant' AND payload IS NOT NULL
          AND created_at > now() - interval '24 hours'
      ) rt WHERE total_ms IS NOT NULL) AS researcher_median_ms
  `);
  const rows: Row[] = Array.isArray(res) ? res : (res as unknown as { rows: Row[] }).rows ?? [];
  const r = rows[0];

  const [queues, llm, clusterWorkers] = await Promise.all([
    queueDepths().catch((e) => {
      console.warn('[infra] queue depths unavailable', e instanceof Error ? e.message : e);
      return null;
    }),
    llmHealth(),
    clusterWorkerCount(),
  ]);

  return {
    queuesEnabled: queuesEnabled(),
    llm,
    clusterWorkers,
    queues,
    summaries: { pending: r.pending, processing: r.processing, failed: r.failed, done: r.done },
    medianLatencyMs: r.median_ms === null ? null : Number(r.median_ms),
    dbBytes: Number(r.db_bytes),
    sessionsBytes: Number(r.sessions_bytes),
    rollups: { count: r.rollup_count, freshestHour: r.rollup_freshest ? new Date(r.rollup_freshest) : null },
    researcher: {
      questions24h: r.researcher_answers,
      medianRunMs: r.researcher_median_ms === null ? null : Number(r.researcher_median_ms),
    },
  };
}
