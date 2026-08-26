export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { ensureSingletonOrg, ensureAdminUsers, cleanupZeroEventSessions } = await import('./lib/bootstrap');
  const { runRetentionOnce } = await import('./lib/retention');

  // Boot tasks: ensure org exists, prune broken sessions, run retention once
  await ensureSingletonOrg().catch((e) => console.warn('[bootstrap] failed', e));
  await ensureAdminUsers().catch((e) => console.warn('[bootstrap] admin seed failed', e));
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
  const { queuesEnabled, enqueueSignals, redisConnection } = await import('./lib/queue');

  // Session narratives: sweep and processing are INDEPENDENT. Sweep
  // creates the work rows; with Redis the work flows through BullMQ
  // (dedicated workers + a reconciler that turns due DB rows into
  // deduped job signals), without it the original drain loops run.
  // Either way the DB rows stay the source of truth.
  let sweepInFlight = false;
  // Set by the queue block below: enqueue signals immediately after a
  // sweep lands new rows, instead of waiting for the next reconcile.
  let afterSweep: (() => Promise<void>) | null = null;
  const sweepCycle = async () => {
    if (sweepInFlight) return;
    sweepInFlight = true;
    try { await runSummarySweepOnce(); }
    catch (e) { console.warn('[summaries] sweep failed', e); }
    try { await sweepUserProfilesOnce(); }
    catch (e) { console.warn('[profiles] sweep failed', e); }
    try { await afterSweep?.(); }
    catch (e) { console.warn('[queue] post-sweep enqueue failed', e); }
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

    // Reconciler: due DB rows → deduped job signals. Also the recovery
    // path if Redis lost jobs — the DB always knows what's owed. When
    // Redis itself is down, degrade to one direct drain pass so an
    // outage never stalls AI processing (the DB claims make this safe
    // alongside workers that come back).
    let fallbackInFlight = false;
    const reconcile = async () => {
      try {
        await enqueueSignals('summaries', await duePendingSummaries());
        await enqueueSignals('profiles', await duePendingProfiles());
      } catch (e) {
        console.warn('[queue] reconcile failed — draining directly', e instanceof Error ? e.message : e);
        if (fallbackInFlight) return;
        fallbackInFlight = true;
        try { await drainSummaryQueue(); await drainUserProfiles(); }
        catch (e2) { console.warn('[queue] fallback drain failed', e2); }
        finally { fallbackInFlight = false; }
      }
    };
    setTimeout(reconcile, 10 * 1000);
    setInterval(reconcile, 60 * 1000);
    // Fresh work should not wait for the next reconcile tick: enqueue
    // right after each sweep lands new rows.
    afterSweep = reconcile;
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
  }
  setInterval(() => {
    resetStuckProcessing().catch((e) => console.warn('[summaries] reset failed', e));
    resetStuckProfiles().catch((e) => console.warn('[profiles] reset failed', e));
  }, 5 * 60 * 1000);
}
