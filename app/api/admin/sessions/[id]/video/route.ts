/**
 * Server-side mp4 export. Drives the Playwright Chromium that's
 * preinstalled in our runner image to play the rrweb replay,
 * captures the recorded webm, transcodes to mp4 with the
 * preinstalled ffmpeg, streams the result back.
 *
 * Real-time: a session of N seconds takes ~N seconds on the server,
 * plus a few seconds of browser startup + ffmpeg transcode.
 */
import { NextRequest, NextResponse } from 'next/server';
import { db, schema } from '@/lib/db';
import { and, eq } from 'drizzle-orm';
import { readSessionCookie } from '@/lib/auth';
import { gunzipSync } from 'node:zlib';
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const runtime = 'nodejs';

const VIDEO_W = 1280;
const VIDEO_H = 720;
const MAX_RENDER_MS = 30 * 60 * 1000; // 30 min cap

// Inline rrweb-player rather than load from a CDN — jsdelivr serves
// .cjs files with Content-Type: application/node, which browsers
// refuse to execute as JavaScript. <script src=cdn> ends up with
// window.rrwebPlayer === undefined. Reading the umd file from local
// node_modules and embedding it directly sidesteps the MIME issue.
const PLAYER_JS = readFileSync(
  join(process.cwd(), 'node_modules/rrweb-player/dist/rrweb-player.umd.cjs'),
  'utf8',
);
const PLAYER_CSS = readFileSync(
  join(process.cwd(), 'node_modules/rrweb-player/dist/style.min.css'),
  'utf8',
);

function buildReplayHtml(events: unknown[], width: number, height: number): string {
  const eventsJson = JSON.stringify(events).replace(/<\/(script)/gi, '<\\/$1');
  return `<!doctype html>
<html><head>
<meta charset="utf-8">
<style>${PLAYER_CSS}</style>
<style>
  html,body{margin:0;padding:0;background:#fff;width:100%;height:100%;overflow:hidden;}
  #player,#player>div,.rr-player,.replayer-wrapper{width:100%!important;height:100%!important;}
  .rr-controller{display:none!important;}
</style>
</head><body>
<div id="player"></div>
<script id="events" type="application/json">${eventsJson}</script>
<script>${PLAYER_JS}</script>
<script>
window.__replayDone = false;
window.__replayError = null;
try {
  var events = JSON.parse(document.getElementById('events').textContent);
  var Player = (window.rrwebPlayer && window.rrwebPlayer.default) || window.rrwebPlayer;
  if (!Player) throw new Error('rrweb-player did not load');
  var p = new Player({
    target: document.getElementById('player'),
    props: {
      events: events,
      autoPlay: true,
      showController: false,
      skipInactive: false,
      width: ${width},
      height: ${height},
    }
  });
  p.addEventListener('finish', function () { window.__replayDone = true; });
} catch (e) {
  window.__replayError = String(e && e.message || e);
}
</script>
</body></html>`;
}

export async function GET(_req: NextRequest | Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await readSessionCookie();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { id } = await ctx.params;

  const rows = await db
    .select({
      id: schema.sessions.id,
      blobData: schema.sessions.blobData,
      durationMs: schema.sessions.durationMs,
      eventCount: schema.sessions.eventCount,
    })
    .from(schema.sessions)
    .innerJoin(schema.projects, eq(schema.projects.id, schema.sessions.projectId))
    .where(and(eq(schema.sessions.id, id), eq(schema.projects.orgId, session.orgId)))
    .limit(1);
  if (rows.length === 0) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const row = rows[0];
  if (!row.blobData || row.blobData.length === 0 || row.eventCount === 0) {
    return NextResponse.json({ error: 'no events to render' }, { status: 404 });
  }
  if (!row.durationMs || row.durationMs <= 0) {
    return NextResponse.json({ error: 'session has no duration' }, { status: 400 });
  }
  if (row.durationMs > MAX_RENDER_MS) {
    return NextResponse.json({ error: 'session too long to render (max 30 min)' }, { status: 400 });
  }

  let plain: string;
  try {
    plain = gunzipSync(row.blobData).toString('utf8');
  } catch {
    return NextResponse.json({ error: 'corrupt blob' }, { status: 500 });
  }
  const events = plain.split('\n').filter((l) => l.trim().length > 0).map((l) => JSON.parse(l));
  if (events.length === 0) return NextResponse.json({ error: 'no events' }, { status: 404 });

  const tempDir = await mkdtemp(join(tmpdir(), 'replay-'));
  let webmPath: string | null = null;

  try {
    const browser = await chromium.launch({
      // --no-sandbox is required when Chromium runs as non-root in a
      // container. --disable-dev-shm-usage avoids the tiny /dev/shm
      // crash inside Docker.
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });
    try {
      const context = await browser.newContext({
        viewport: { width: VIDEO_W, height: VIDEO_H },
        recordVideo: { dir: tempDir, size: { width: VIDEO_W, height: VIDEO_H } },
      });
      const page = await context.newPage();
      await page.setContent(buildReplayHtml(events, VIDEO_W, VIDEO_H), { waitUntil: 'load' });
      await page.waitForFunction(
        () => {
          const w = window as unknown as { __replayDone?: boolean; __replayError?: string | null };
          return w.__replayDone === true || (w.__replayError != null);
        },
        undefined,
        { timeout: row.durationMs + 30_000 },
      );
      const replayError = await page.evaluate(() => (window as unknown as { __replayError?: string | null }).__replayError ?? null);
      await context.close();
      if (replayError) throw new Error(`replay script error: ${replayError}`);
      const files = await readdir(tempDir);
      const webm = files.find((f) => f.endsWith('.webm'));
      if (!webm) throw new Error('playwright produced no video file');
      webmPath = join(tempDir, webm);
    } finally {
      await browser.close().catch(() => {});
    }
  } catch (err) {
    console.warn('[video] render failed', err);
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    const msg = err instanceof Error ? err.message : 'render failed';
    return NextResponse.json({ error: msg }, { status: 500 });
  }

  const mp4Path = join(tempDir, 'out.mp4');
  try {
    await new Promise<void>((resolve, reject) => {
      const ff = spawn('ffmpeg', [
        '-y',
        '-i', webmPath!,
        '-c:v', 'libx264',
        '-preset', 'fast',
        '-crf', '23',
        '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart',
        mp4Path,
      ], { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      ff.stderr.on('data', (b) => { stderr += b.toString(); });
      ff.on('error', reject);
      ff.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-500)}`));
      });
    });
  } catch (err) {
    console.warn('[video] ffmpeg failed', err);
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    return NextResponse.json({ error: 'mp4 transcode failed' }, { status: 500 });
  }

  let buf: Buffer;
  try {
    buf = await readFile(mp4Path);
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }

  return new Response(new Uint8Array(buf), {
    headers: {
      'content-type': 'video/mp4',
      'content-disposition': `attachment; filename="session-${id.slice(0, 8)}.mp4"`,
      'content-length': String(buf.length),
      'cache-control': 'private, no-store',
    },
  });
}
