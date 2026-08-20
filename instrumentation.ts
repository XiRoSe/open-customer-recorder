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

  // Session narratives: digest ended sessions, then drain the LLM queue in
  // one burst (keeps the app-sleeping summarizer awake only once per cycle).
  // The inFlight flag stops cycles from stacking when a burst outlives the
  // interval (CPU inference is 15-30s per summary).
  let summaryInFlight = false;
  const summaryCycle = async () => {
    if (summaryInFlight) return;
    summaryInFlight = true;
    try {
      await resetStuckProcessing();
      await runSummarySweepOnce();
      await drainSummaryQueue();
    } catch (e) {
      console.warn('[summaries] cycle failed', e);
    } finally {
      summaryInFlight = false;
    }
  };
  summaryCycle(); // boot run backfills existing history batch by batch
  setInterval(summaryCycle, 60 * 1000);
}
