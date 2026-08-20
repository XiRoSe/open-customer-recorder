// Self-contained rrweb replay page for headless Chromium: used by the mp4
// export (real-time playback + recording) and the frame renderer (paused
// player + goto + screenshot). Inlines rrweb-player from node_modules —
// jsdelivr serves .cjs with Content-Type: application/node, which browsers
// refuse to execute, so a CDN <script src> ends up undefined.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PLAYER_JS = readFileSync(
  join(process.cwd(), 'node_modules/rrweb-player/dist/rrweb-player.umd.cjs'),
  'utf8',
);
const PLAYER_CSS = readFileSync(
  join(process.cwd(), 'node_modules/rrweb-player/dist/style.min.css'),
  'utf8',
);

export function buildReplayHtml(events: unknown[], width: number, height: number, opts?: { autoPlay?: boolean }): string {
  const autoPlay = opts?.autoPlay ?? true;
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
window.__player = null;
try {
  var events = JSON.parse(document.getElementById('events').textContent);
  var Player = (window.rrwebPlayer && window.rrwebPlayer.default) || window.rrwebPlayer;
  if (!Player) throw new Error('rrweb-player did not load');
  var p = new Player({
    target: document.getElementById('player'),
    props: {
      events: events,
      autoPlay: ${autoPlay},
      showController: false,
      skipInactive: false,
      width: ${width},
      height: ${height},
    }
  });
  window.__player = p;
  p.addEventListener('finish', function () { window.__replayDone = true; });
} catch (e) {
  window.__replayError = String(e && e.message || e);
}
</script>
</body></html>`;
}
