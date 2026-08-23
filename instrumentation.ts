export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { ensureSingletonOrg, cleanupZeroEventSessions } = await import('./lib/bootstrap');
  const { runRetentionOnce } = await import('./lib/retention');

  // Boot tasks: ensure org exists, prune broken sessions, run retention once
  await ensureSingletonOrg().catch((e) => console.warn('[bootstrap] failed', e));
  await cleanupZeroEventSessions().catch((e) => console.warn('[cleanup] failed', e));
  await runRetentionOnce().catch((e) => console.warn('[retention] boot run failed', e));

  // Hourly retention loop
  setInterval(() => {
    runRetentionOnce().catch((e) => console.warn('[retention] hourly run failed', e));
  }, 60 * 60 * 1000);

  // Periodic cleanup so 0-event orphan rows never accumulate
  // (e.g. from a /start that raced with page unload). 5-min cadence
  // pairs with the 5-min row-age threshold in cleanupZeroEventSessions.
  setInterval(() => {
    cleanupZeroEventSessions().catch((e) => console.warn('[cleanup] interval run failed', e));
  }, 5 * 60 * 1000);

  const { runSummarySweepOnce } = await import('./lib/session-summaries');
  const { drainSummaryQueue, processNextSummary, duePendingSummaries, resetStuckProcessing } = await import('./lib/summary-worker');
  const { sweepUserProfilesOnce, drainUserProfiles, processNextProfile, duePendingProfiles, resetStuckProfiles } = await import('./lib/user-profiles');
  const { runClusteringOnce } = await import('./lib/user-segments');
  const { refreshTimelineAnalyses } = await import('./lib/timeline');
  const { queuesEnabled, getQueue, enqueueSignals, redisConnection } = await import('./lib/queue');

  // Session narratives: sweep and processing are INDEPENDENT. Sweep
  // creates the work rows; with Redis the work flows through BullMQ
  // (dedicated workers + a reconciler that turns due DB rows into
  // deduped job signals), without it the original drain loops run.
  // Either way the DB rows stay the source of truth.
  let sweepInFlight = false;
  const sweepCycle = async () => {
    if (sweepInFlight) return;
    sweepInFlight = true;
    try { await runSummarySweepOnce(); }
    catch (e) { console.warn('[summaries] sweep failed', e); }
    try { await sweepUserProfilesOnce(); }
    catch (e) { console.warn('[profiles] sweep failed', e); }
    finally { sweepInFlight = false; }
  };
  resetStuckProcessing().catch((e) => console.warn('[summaries] reset failed', e));
  sweepCycle();
  setInterval(sweepCycle, 60 * 1000);

  if (queuesEnabled()) {
    const { Worker } = await import('bullmq');
    const connection = redisConnection()!;
    // Serial LLM lanes: llama.cpp has one slot; concurrency stays 1 per
    // queue so requests never contend for context.
    new Worker('summaries', async () => { await processNextSummary(); }, { connection, concurrency: 1 })
      .on('error', (e) => console.warn('[queue] summaries worker error', e.message));
    new Worker('profiles', async () => { await processNextProfile(); }, { connection, concurrency: 1 })
      .on('error', (e) => console.warn('[queue] profiles worker error', e.message));
    const { buildHourRollup } = await import('./lib/rollups');
    new Worker('aggregation', async (job) => {
      const { projectId, hourStart } = job.data as { projectId: string; hourStart: number };
      await buildHourRollup(projectId, hourStart);
    }, { connection, concurrency: 2 })
      .on('error', (e) => console.warn('[queue] aggregation worker error', e.message));

    // Reconciler: due DB rows → deduped job signals. Also the recovery
    // path if Redis lost jobs — the DB always knows what's owed.
    const reconcile = async () => {
      try {
        await enqueueSignals('summaries', await duePendingSummaries());
        await enqueueSignals('profiles', await duePendingProfiles());
      } catch (e) { console.warn('[queue] reconcile failed', e); }
    };
    setTimeout(reconcile, 10 * 1000);
    setInterval(reconcile, 60 * 1000);

    // Aggregation scheduler: rollup jobs for missing + recent hours.
    const { db, schema } = await import('./lib/db');
    const { hoursNeedingRollup } = await import('./lib/rollups');
    const scheduleRollups = async () => {
      try {
        const projects = await db.select({ id: schema.projects.id }).from(schema.projects);
        const q = getQueue('aggregation');
        if (!q) return;
        for (const p of projects) {
          const hours = await hoursNeedingRollup(p.id);
          if (hours.length === 0) continue;
          await q.addBulk(hours.map((h) => ({
            name: 'rollup',
            data: { projectId: p.id, hourStart: h },
            opts: { jobId: `roll:${p.id}:${h}` },
          })));
        }
      } catch (e) { console.warn('[queue] rollup scheduling failed', e); }
    };
    setTimeout(scheduleRollups, 30 * 1000);
    setInterval(scheduleRollups, 10 * 60 * 1000);
    // Clustering runs in the standalone cluster service (it schedules
    // its own repeatable job on the 'clustering' queue).
    console.log('[queue] BullMQ mode: workers + reconciler armed');
  } else {
    // Legacy in-process mode — no Redis configured.
    let drainInFlight = false;
    const drainCycle = async () => {
      if (drainInFlight) return;
      drainInFlight = true;
      // Sessions first, then visitor profiles — profiles feed on the
      // session summaries the first drain just produced.
      try { await drainSummaryQueue(); }
      catch (e) { console.warn('[summaries] drain failed', e); }
      try { await drainUserProfiles(); }
      catch (e) { console.warn('[profiles] cycle failed', e); }
      finally { drainInFlight = false; }
    };
    drainCycle();
    setInterval(drainCycle, 60 * 1000);
    // Segments: recluster when profiles changed. Cheap when nothing did.
    let clusterInFlight = false;
    const clusterCycle = async () => {
      if (clusterInFlight) return;
      clusterInFlight = true;
      try { await runClusteringOnce(); }
      catch (e) { console.warn('[segments] cycle failed', e); }
      finally { clusterInFlight = false; }
    };
    setTimeout(clusterCycle, 2 * 60 * 1000); // let the first drains land
    setInterval(clusterCycle, 10 * 60 * 1000);
  }
  // Timeline analyst reads: cached per (project, range), stale after 6h —
  // the cycle itself is a no-op when everything is fresh.
  let timelineInFlight = false;
  const timelineCycle = async () => {
    if (timelineInFlight) return;
    timelineInFlight = true;
    try { await refreshTimelineAnalyses(); }
    catch (e) { console.warn('[timeline] cycle failed', e); }
    finally { timelineInFlight = false; }
  };
  setTimeout(timelineCycle, 4 * 60 * 1000);
  setInterval(timelineCycle, 60 * 60 * 1000);
  setInterval(() => {
    resetStuckProcessing().catch((e) => console.warn('[summaries] reset failed', e));
    resetStuckProfiles().catch((e) => console.warn('[profiles] reset failed', e));
  }, 5 * 60 * 1000);
}
