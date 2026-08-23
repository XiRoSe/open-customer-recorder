// Job queues on Redis (BullMQ). The database stays the source of truth
// for work state (status columns, SKIP LOCKED claims); the queues carry
// work SIGNALS with dedupe, retries stay DB-driven. Without REDIS_URL
// everything degrades to the original in-process loops — the queues are
// an accelerator, never a requirement.
import { Queue } from 'bullmq';
import IORedis from 'ioredis';

export const QUEUE_NAMES = ['summaries', 'profiles', 'clustering', 'aggregation'] as const;
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
        // retries and the recurring rollup refresh. The DB is the trail.
        removeOnComplete: true,
        removeOnFail: true,
      },
    });
    queues.set(name, q);
  }
  return q;
}

/** Enqueue one job per id, deduped by jobId — re-enqueueing a pending
 * id is a no-op while its job still exists. Priority: newer first. */
export async function enqueueSignals(name: QueueName, ids: { id: string; ageMinutes?: number }[]): Promise<number> {
  const q = getQueue(name);
  if (!q || ids.length === 0) return 0;
  await q.addBulk(ids.map(({ id, ageMinutes }) => ({
    name: 'work',
    data: { id },
    opts: {
      jobId: id,
      // BullMQ: lower priority number = processed sooner.
      priority: Math.min(2_000_000, Math.max(1, Math.round(ageMinutes ?? 1))),
    },
  })));
  return ids.length;
}

/** Depths for the Infra page; null when queues are off. */
export async function queueDepths(): Promise<Record<QueueName, { waiting: number; active: number; failed: number }> | null> {
  if (!queuesEnabled()) return null;
  const out = {} as Record<QueueName, { waiting: number; active: number; failed: number }>;
  for (const name of QUEUE_NAMES) {
    const q = getQueue(name);
    if (!q) return null;
    const c = await q.getJobCounts('waiting', 'active', 'failed', 'delayed', 'prioritized');
    out[name] = {
      waiting: (c.waiting ?? 0) + (c.delayed ?? 0) + (c.prioritized ?? 0),
      active: c.active ?? 0,
      failed: c.failed ?? 0,
    };
  }
  return out;
}
