'use client';
import { useEffect, useRef, useState } from 'react';
import type rrwebPlayer from 'rrweb-player';
import 'rrweb-player/dist/style.css';
import { Download, Globe, Loader2, User } from 'lucide-react';
import { buildUrlTimeline, urlAtTime, type UrlTimelineEntry } from '@/lib/url-timeline';

interface Props {
  sessionId: string;
  eventCount: number;
  /** Link to the visitor's filtered sessions list — renders a
   * "More from this user" button beside Download. */
  userHref?: string;
}

export function ReplayPlayer({ sessionId, eventCount, userHref }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [renderingMp4, setRenderingMp4] = useState(false);
  const [downloadErr, setDownloadErr] = useState<string | null>(null);
  const [currentUrl, setCurrentUrl] = useState<string | null>(null);
  const timelineRef = useRef<UrlTimelineEntry[]>([]);
  const baseTsRef = useRef(0);

  useEffect(() => {
    if (eventCount === 0) {
      setError('This session captured no events — likely a quick visit before any DOM mutations or interactions occurred.');
      return;
    }

    let player: rrwebPlayer | null = null;
    let cancelled = false;

    (async () => {
      const res = await fetch(`/api/admin/sessions/${sessionId}/blob`, { cache: 'no-store' });
      if (!res.ok) {
        if (res.status === 404) {
          setError('No replay data was uploaded for this session.');
        } else {
          setError(`Could not load session blob (status ${res.status}).`);
        }
        return;
      }
      const text = await res.text();
      const events = text.split('\n').filter((l) => l.trim().length).map((l) => JSON.parse(l));
      if (events.length === 0) {
        setError('Session blob is empty.');
        return;
      }
      if (cancelled || !ref.current) return;
      const timeline = buildUrlTimeline(events);
      timelineRef.current = timeline;
      baseTsRef.current = events[0].timestamp;
      setCurrentUrl(urlAtTime(timeline, events[0].timestamp));
      const Player = (await import('rrweb-player')).default;
      player = new Player({
        target: ref.current,
        props: {
          events,
          autoPlay: false,
          showController: true,
          // Keep idle time visible so the timeline matches real duration
          // (default true compresses 50s of "idle" looking-at-the-page into a few seconds).
          skipInactive: false,
          width: ref.current.clientWidth,
          height: 600,
        },
      });
      player.addEventListener('ui-update-current-time', (params: unknown) => {
        const t = (params as { payload?: unknown } | null)?.payload;
        if (typeof t === 'number') {
          setCurrentUrl(urlAtTime(timelineRef.current, baseTsRef.current + t));
        }
      });
    })();

    return () => {
      cancelled = true;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = player as any;
      if (p?.destroy) p.destroy();
      if (ref.current) ref.current.innerHTML = '';
    };
  }, [sessionId, eventCount]);

  /**
   * Server-side render to mp4. Hits /api/admin/sessions/[id]/video
   * which drives headless Chromium via Playwright to play the replay,
   * captures it to webm, then transcodes to mp4 via ffmpeg. Render
   * takes roughly real-time — the spinner stays up while we wait.
   */
  async function downloadMp4() {
    setDownloadErr(null);
    setRenderingMp4(true);
    try {
      const res = await fetch(`/api/admin/sessions/${sessionId}/video`, { cache: 'no-store' });
      if (!res.ok) {
        let msg = `Render failed (status ${res.status}).`;
        try {
          const j = await res.json();
          if (j?.error) msg = String(j.error);
        } catch {}
        setDownloadErr(msg);
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `session-${sessionId.slice(0, 8)}.mp4`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setDownloadErr(e instanceof Error ? e.message : 'Render failed.');
    } finally {
      setRenderingMp4(false);
    }
  }

  if (error) {
    return (
      <div className="rounded-lg border bg-muted/30 p-8 text-center text-sm text-muted-foreground">
        {error}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-end gap-3">
        {userHref && (
          <a
            href={userHref}
            className="inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted"
          >
            <User className="h-4 w-4" />
            More from this user
          </a>
        )}
        <button
          type="button"
          onClick={downloadMp4}
          disabled={renderingMp4 || eventCount === 0}
          aria-label="Download replay"
          className="inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted disabled:opacity-50 disabled:pointer-events-none"
        >
          {renderingMp4 ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
          {renderingMp4 ? 'Rendering…' : 'Download'}
        </button>
      </div>
      {downloadErr && <p className="text-xs text-destructive">{downloadErr}</p>}
      {currentUrl && (
        <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-1.5">
          <Globe className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <a
            href={currentUrl}
            target="_blank"
            rel="noopener noreferrer"
            title={currentUrl}
            className="truncate font-mono text-xs text-muted-foreground hover:text-foreground hover:underline"
          >
            {currentUrl}
          </a>
        </div>
      )}
      <div ref={ref} className="rounded-lg border bg-card" />
    </div>
  );
}
