'use client';

// Block renderers for Researcher answers: evidence bars, sessions to
// watch, comparison tables, and the tag-draft Apply card. The resolving
// numbers here are pure presentation — the values arrived precomputed
// from the executor, the animation just settles onto them.
//
// Rich boxes (chart / clusterMap / analysis) wrap the app's REAL
// TimelineChart / ClusterMap / AnalystReadCard components — the drawer
// skips them entirely (kept compact); the workspace and share surfaces
// render them as framed ResearchBoxes.
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import type { Citation, ResearcherBlock } from '@/lib/researcher/types';
import { TAG_COLOR_HEX, type TagColor } from '@/lib/tag-colors';
import { TimelineChart } from '@/components/timeline-chart';
import { ClusterMap } from '@/components/cluster-map';
import { AnalystReadCard } from '@/components/analyst-read-card';
import { useSurface } from './surface';
import styles from './researcher.module.css';

function fmtDur(ms: number | null): string {
  if (!ms) return '—';
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

function fmtWhen(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/** Muted → tick up → brass underline flash. */
function ResolvingNumber({ value, display }: { value: number; display?: string }) {
  const [shown, setShown] = useState(0);
  const [resolved, setResolved] = useState(false);
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const steps = 10;
    let cur = 0;
    const t = setInterval(() => {
      cur++;
      setShown(Math.round((value * cur) / steps));
      if (cur >= steps) { clearInterval(t); setResolved(true); }
    }, 40);
    return () => clearInterval(t);
  }, [value]);
  return <span className={resolved ? styles.numResolved : undefined}>{resolved && display ? display : shown.toLocaleString()}</span>;
}

function EvidenceBlock({ block }: { block: Extract<ResearcherBlock, { type: 'evidence' }> }) {
  const max = Math.max(...block.rows.map((r) => r.value), 1);
  const [grown, setGrown] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setGrown(true), 60);
    return () => clearTimeout(t);
  }, []);
  return (
    <div>
      <div className={styles.blockLabel}>{block.title}</div>
      <div className={styles.viz}>
        {block.rows.map((r, i) => (
          <div key={r.label} className={`${styles.vRow} ${i === 0 ? styles.vRowHot : ''}`}>
            <span className={styles.vLab} title={r.label}>{r.label}</span>
            <span className={styles.vTrack}>
              <span className={styles.vFill} style={{ width: grown ? `${Math.round((100 * r.value) / max)}%` : 0 }} />
            </span>
            <span className={styles.vVal}><ResolvingNumber value={r.value} display={r.display} /></span>
          </div>
        ))}
      </div>
    </div>
  );
}

function SessionsBlock({ block }: { block: Extract<ResearcherBlock, { type: 'sessions' }> }) {
  return (
    <div>
      <div className={styles.blockLabel}>{block.title}</div>
      <div className={styles.watch}>
        {block.items.map((s) => (
          <Link key={s.id} href={`/sessions/${s.id}`} className={styles.wRow} target="_blank">
            <span className={styles.wTime}>{fmtWhen(s.startedAt)} · {fmtDur(s.durationMs)}</span>
            <span className={styles.wDesc}>
              {s.frustrated ? '⚡ ' : ''}{s.note || `${s.pages} page${s.pages === 1 ? '' : 's'}${s.country ? ` · ${s.country}` : ''}`}
            </span>
            <span className={styles.wPlay}>▶ replay</span>
          </Link>
        ))}
      </div>
    </div>
  );
}

function TableBlock({ block }: { block: Extract<ResearcherBlock, { type: 'table' }> }) {
  return (
    <div>
      <div className={styles.blockLabel}>{block.title}</div>
      <table className={styles.tbl}>
        <thead><tr>{block.columns.map((c) => <th key={c}>{c}</th>)}</tr></thead>
        <tbody>
          {block.rows.map((r, i) => (
            <tr key={i}>{r.map((cell, j) => <td key={j}>{cell}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TagDraftBlock({ block, projectId, threadId }: {
  block: Extract<ResearcherBlock, { type: 'tagDraft' }>;
  projectId: string;
  threadId: string | null;
}) {
  const [state, setState] = useState<'idle' | 'applying' | 'applied' | 'error'>('idle');
  const [applied, setApplied] = useState(0);
  const apply = async () => {
    setState('applying');
    try {
      const res = await fetch(`/api/admin/projects/${projectId}/researcher/apply-tag`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: block.name, kind: block.kind, value: block.value, color: block.color, threadId }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || 'apply failed');
      setApplied(j.appliedCount ?? 0);
      setState('applied');
    } catch {
      setState('error');
    }
  };
  const ruleWords = block.kind === 'url_contains'
    ? `pages containing “${block.value}”`
    : `visitors with ${block.value}+ sessions`;
  return (
    <div className={styles.confirm}>
      <span className={styles.swatch} style={{ background: TAG_COLOR_HEX[block.color as TagColor] ?? '#3b82f6' }} />
      <span className={styles.confirmWhat}>
        <b>{block.name}</b>
        <small>{ruleWords} · you apply, I only draft</small>
      </span>
      {state === 'applied'
        ? <span className={styles.applied}>Applied ✓ {applied > 0 ? `· ${applied} tagged` : ''}</span>
        : state === 'error'
          ? <span className={styles.applied} style={{ color: '#e11d48' }}>failed — retry?</span>
          : (
            <button type="button" className={styles.applyBtn} onClick={apply} disabled={state === 'applying'}>
              {state === 'applying' ? 'Applying…' : 'Apply'}
            </button>
          )}
    </div>
  );
}

/** The frame every rich box shares: kind label, title, a window note
 * pill, and the deep link into the real full-page view. */
function ResearchBox({ kind, title, windowNote, href, children }: {
  kind: string;
  title: string;
  windowNote?: string;
  href?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={styles.box}>
      <div className={styles.boxHead}>
        <span className={styles.boxKind}>{kind}</span>
        <span className={styles.boxTitle}>{title}</span>
        {windowNote && <span className={styles.pillNote}><i />{windowNote}</span>}
        {href && <Link className={styles.boxOpen} href={href} target="_blank" rel="noreferrer">Open full view ↗</Link>}
      </div>
      <div className={styles.boxBody}>{children}</div>
    </div>
  );
}

function ChartBox({ block, projectId }: { block: Extract<ResearcherBlock, { type: 'chart' }>; projectId: string }) {
  return (
    <ResearchBox kind="Timeline" title={block.title} windowNote={block.windowNote} href={block.href}>
      <TimelineChart
        buckets={block.buckets}
        bucketMs={block.bucketMs}
        tagMeta={block.tagMeta}
        sessionsBasePath={`/projects/${projectId}/sessions`}
        initialMetric={block.initialMetric as never}
        embedded
      />
    </ResearchBox>
  );
}

function ClusterMapBox({ block, projectId }: { block: Extract<ResearcherBlock, { type: 'clusterMap' }>; projectId: string }) {
  return (
    <ResearchBox kind="Clusters" title={block.title} windowNote={block.windowNote} href={block.href}>
      <ClusterMap
        dims={block.dims}
        sessionsBasePath={`/projects/${projectId}/sessions`}
        initialDimension={block.initialDimension ?? undefined}
        initialSegment={block.initialSegment ?? undefined}
        embedded
      />
    </ResearchBox>
  );
}

function AnalysisBox({ block }: { block: Extract<ResearcherBlock, { type: 'analysis' }> }) {
  return (
    <ResearchBox kind="Analyst read" title={block.title}>
      <AnalystReadCard analysis={block.text} patterns={block.patterns} />
    </ResearchBox>
  );
}

export function BlockView({ block, projectId, threadId }: {
  block: ResearcherBlock;
  projectId: string;
  threadId: string | null;
}) {
  // The drawer stays compact — it never renders the rich boxes, only
  // the surfaces with room for them (workspace, share).
  const surface = useSurface();

  switch (block.type) {
    case 'evidence': return <EvidenceBlock block={block} />;
    case 'sessions': return <SessionsBlock block={block} />;
    case 'table': return <TableBlock block={block} />;
    case 'tagDraft': return <TagDraftBlock block={block} projectId={projectId} threadId={threadId} />;
    case 'chart': return surface === 'drawer' ? null : <ChartBox block={block} projectId={projectId} />;
    case 'clusterMap': return surface === 'drawer' ? null : <ClusterMapBox block={block} projectId={projectId} />;
    case 'analysis': return surface === 'drawer' ? null : <AnalysisBox block={block} />;
    default: return null;
  }
}

export function CitationChips({ citations }: { citations: Citation[] }) {
  const [open, setOpen] = useState<number | null>(null);
  useEffect(() => {
    const close = () => setOpen(null);
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, []);
  if (citations.length === 0) return null;
  return (
    <div className={styles.cites}>
      {citations.map((c, i) => (
        <button
          key={i}
          type="button"
          className={styles.cite}
          onClick={(e) => { e.stopPropagation(); setOpen(open === i ? null : i); }}
        >
          {c.label}
          {open === i && (
            <span className={styles.pop} onClick={(e) => e.stopPropagation()}>
              <b>{c.label}</b>
              <div className={styles.popQ}>{c.detail}</div>
              {c.href && <Link className={styles.popA} href={c.href} target="_blank">Open in dashboard →</Link>}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}
