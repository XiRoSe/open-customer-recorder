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
  const { drainSummaryQueue, resetStuckProcessing } = await import('./lib/summary-worker');
  const { sweepUserProfilesOnce, drainUserProfiles } = await import('./lib/user-profiles');
  const { runClusteringOnce } = await import('./lib/user-segments');
  const { refreshTimelineAnalyses } = await import('./lib/timeline');

  // Session narratives: three INDEPENDENT loops. Sweep and drain must not
  // share a cycle — a large backlog drain can run for hours, and fresh
  // sessions would get no digest (and no narrative) until it finished.
  // Each loop has its own inFlight guard so slow runs don't stack.
  let sweepInFlight = false;
  const sweepCycle = async () => {
    if (sweepInFlight) return;
    sweepInFlight = true;
    try { await runSummarySweepOnce(); }
    catch (e) { console.warn('[summaries] sweep failed', e); }
    finally { sweepInFlight = false; }
  };
  let drainInFlight = false;
  const drainCycle = async () => {
    if (drainInFlight) return;
    drainInFlight = true;
    // Sessions first, then visitor profiles — profiles feed on the
    // session summaries the first drain just produced.
    try { await drainSummaryQueue(); }
    catch (e) { console.warn('[summaries] drain failed', e); }
    try { await sweepUserProfilesOnce(); await drainUserProfiles(); }
    catch (e) { console.warn('[profiles] cycle failed', e); }
    finally { drainInFlight = false; }
  };
  // Boot: recover rows orphaned in 'processing' by a mid-call restart,
  // then start sweeping/draining.
  resetStuckProcessing().catch((e) => console.warn('[summaries] reset failed', e));
  sweepCycle();
  drainCycle();
  setInterval(sweepCycle, 60 * 1000);
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
  }, 5 * 60 * 1000);
}
