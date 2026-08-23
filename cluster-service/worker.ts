// Standalone clustering service: consumes the 'clustering' queue and
// runs the full embed → cluster → project → explain cycle against the
// shared database. It schedules its own repeatable job, so no other
// service needs to know its cadence. Deployed as its own Railway
// service; the app stops clustering in-process as soon as REDIS_URL is
// set on both sides.
import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { runClusteringOnce } from '@/lib/user-segments';

const redisUrl = process.env.REDIS_URL;
if (!redisUrl) {
  console.error('[cluster-service] REDIS_URL is required');
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error('[cluster-service] DATABASE_URL is required');
  process.exit(1);
}

const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });

const queue = new Queue('clustering', { connection });
await queue.upsertJobScheduler('recluster-every-10m', { every: 10 * 60 * 1000 }, {
  name: 'recluster',
  opts: { removeOnComplete: { count: 20 }, removeOnFail: { count: 20 } },
});

let running = false;
const worker = new Worker('clustering', async (job) => {
  if (running) { console.log('[cluster-service] cycle already running, skipping', job.id); return; }
  running = true;
  const t0 = Date.now();
  try {
    const changed = await runClusteringOnce();
    console.log(`[cluster-service] cycle done in ${Math.round((Date.now() - t0) / 1000)}s (changed: ${changed})`);
  } finally {
    running = false;
  }
}, { connection, concurrency: 1, lockDuration: 15 * 60 * 1000 });

worker.on('failed', (job, err) => console.warn('[cluster-service] job failed', job?.id, err.message));
worker.on('error', (e) => console.warn('[cluster-service] worker error', e.message));
console.log('[cluster-service] up — listening on the clustering queue');
