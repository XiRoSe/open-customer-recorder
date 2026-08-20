// "Light" visual analysis support: instead of playing a session in real
// time, load the replay PAUSED, jump the player to at most two key
// moments, and screenshot small JPEGs for the vision model.
import type { Browser } from 'playwright-core';
import { buildReplayHtml } from './replay-html';
import type { SessionDigest } from './session-digest';

// 640×360 ≈ 242 image tokens ≈ 5s vision eval on the CPU summarizer
// (benchmarked 2026-08-20; tokens scale ~1 per 970 px). UI text is still
// legible to the model at this size.
export const FRAME_W = 640;
export const FRAME_H = 360;
export const MAX_FRAMES = 2;

/** Moments to screenshot, as ms offsets from session start.
 * 1) The first "something went wrong" moment (insights with a real
 *    timestamp), else mid-session. 2) The final activity moment — what
 *    the visitor left on. Deduped when closer than 2s, capped at 2. */
export function pickFrameMoments(digest: SessionDigest): number[] {
  if (digest.steps.length === 0) return [];
  const t0 = digest.steps[0].t;
  const durationMs = Math.max(0, digest.stats.durationMs);
  const insightAt = digest.insights.find((i) => i.at > 0)?.at;
  const first = insightAt !== undefined ? insightAt - t0 : Math.floor(durationMs / 2);
  const last = digest.steps[digest.steps.length - 1].t - t0;
  const clamp = (v: number) => Math.min(Math.max(0, v), durationMs);
  const moments = [clamp(first), clamp(last)];
  if (Math.abs(moments[0] - moments[1]) < 2000) return [moments[1]];
  return moments.slice(0, MAX_FRAMES);
}

// One browser per process: launching costs ~3s, contexts are cheap.
let browserPromise: Promise<Browser> | null = null;
async function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = import('playwright-core').then(({ chromium }) =>
      chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] }),
    );
    browserPromise.then((b) => {
      b.on('disconnected', () => { browserPromise = null; });
    }).catch(() => { browserPromise = null; });
  }
  return browserPromise;
}

/** Render base64 JPEG frames of the replay at the given moments.
 * Throws on any failure — callers treat frames as best-effort. */
export async function renderSessionFrames(ndjson: string, momentsMs: number[]): Promise<string[]> {
  if (momentsMs.length === 0) return [];
  const events = ndjson.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  if (events.length === 0) return [];
  const browser = await getBrowser();
  const context = await browser.newContext({ viewport: { width: FRAME_W, height: FRAME_H } });
  try {
    const page = await context.newPage();
    await page.setContent(buildReplayHtml(events, FRAME_W, FRAME_H, { autoPlay: false }), { waitUntil: 'load' });
    const err = await page.evaluate(() => (window as unknown as { __replayError?: string | null }).__replayError ?? null);
    if (err) throw new Error(`replay script error: ${err}`);
    const frames: string[] = [];
    for (const t of momentsMs.slice(0, MAX_FRAMES)) {
      await page.evaluate((offset) => {
        const p = (window as unknown as { __player?: { goto: (ms: number, play?: boolean) => void; pause?: () => void } }).__player;
        if (!p) throw new Error('player missing');
        p.goto(offset, false);
      }, t);
      // Give the replayer a beat to apply the snapshot + styles.
      await page.waitForTimeout(400);
      const buf = await page.screenshot({ type: 'jpeg', quality: 70 });
      frames.push(buf.toString('base64'));
    }
    return frames;
  } finally {
    await context.close().catch(() => {});
  }
}
