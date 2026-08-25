// Job queues on Redis (BullMQ). The database stays the source of truth
// for work state (status columns, SKIP LOCKED claims); the queues carry
// work SIGNALS with dedupe, retries stay DB-driven. Without REDIS_URL
// everything degrades to the original in-process loops — the queues are
// an accelerator, never a requirement.
import { Queue } from 'bullmq';
import IORedis from 'ioredis';

export const QUEUE_NAMES = ['summaries', 'profiles'] as const;
export type QueueName = (typeof QUEUE_NAMES)[number];

export function queuesEnabled(): boolean {
  return Boolean(process.env.REDIS_URL);
}

let connection: IORedis | null = null;
const queues = new Map<QueueName, Queue>();

export function redisConnection(): IORedis | null {
  if (!queuesEnabled()) return null;
  connection ??= new IORedis(process.env.REDIS_URL!, {
    maxRetriesPerRequest: null,      // required by BullMQ workers
    enableOfflineQueue: false,       // fail fast instead of buffering forever
  });
  connection.on('error', (e) => console.warn('[queue] redis error', e.message));
  return connection;
}

export function getQueue(name: QueueName): Queue | null {
  const conn = redisConnection();
  if (!conn) return null;
  let q = queues.get(name);
  if (!q) {
    q = new Queue(name, {
      connection: conn,
      defaultJobOptions: {
        attempts: 1,             // retries live in the DB rows
        // Jobs must vanish on completion: a finished job's id lingering
        // in the completed/failed sets makes BullMQ silently ignore the
        // next add with the same jobId — which would break DB-driven
        // retries. The DB is the trail.
        removeOnComplete: true,
        removeOnFail: true,
      },
    });
    queues.set(name, q);
  }
  return q;
}

/** Enqueue one job per id, deduped by jobId — re-enqueueing a pending
 * id is a no-op while its job still exists. No priorities: workers are
 * row-agnostic and claim newest-first from the DB regardless of job
 * order, so BullMQ's prioritized set would be dead weight. */
export async function enqueueSignals(name: QueueName, ids: { id: string; ageMinutes?: number }[]): Promise<number> {
  const q = getQueue(name);
  if (!q || ids.length === 0) return 0;
  await q.addBulk(ids.map(({ id }) => ({
    name: 'work',
    data: { id },
    opts: { jobId: id },
  })));
  return ids.length;
}

/** Depths for the Infra page; null when queues are off. Failed counts
 * live in the DB status columns, not here — jobs are removed on
 * completion either way. */
export async function queueDepths(): Promise<Record<QueueName, { waiting: number; active: number }> | null> {
  if (!queuesEnabled()) return null;
  const out = {} as Record<QueueName, { waiting: number; active: number }>;
  for (const name of QUEUE_NAMES) {
    const q = getQueue(name);
    if (!q) return null;
    const c = await q.getJobCounts('waiting', 'active', 'delayed', 'prioritized');
    out[name] = {
      waiting: (c.waiting ?? 0) + (c.delayed ?? 0) + (c.prioritized ?? 0),
      active: c.active ?? 0,
    };
  }
  return out;
}
