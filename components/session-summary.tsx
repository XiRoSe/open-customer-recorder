'use client';

import { useEffect, useState } from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import type { Insight, Step } from '@/lib/session-digest';
import { INSIGHT_META } from '@/lib/insight-meta';

export interface SummaryData {
  narrative: string;
  insights: Insight[];
  intentText: string | null;
  visualUsed: boolean;
  status: string;
  steps: Step[];
}

function insightChips(insights: Insight[]): { label: string; detail?: string }[] {
  const counts = new Map<string, { count: number; detail?: string }>();
  for (const i of insights) {
    const cur = counts.get(i.kind);
    counts.set(i.kind, { count: (cur?.count ?? 0) + (i.count ?? 1), detail: cur?.detail ?? i.detail });
  }
  return [...counts.entries()].map(([kind, { count, detail }]) => ({
    label: `${INSIGHT_META[kind]?.label ?? kind}${count > 1 ? ` ×${count}` : ''}`,
    detail,
  }));
}

function mss(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** "https://site.com/pricing?x=1" → { host: 'site.com', path: '/pricing' } */
function splitUrl(url: string): { host: string; path: string } {
  try {
    const u = new URL(url);
    return { host: u.host, path: u.pathname + (u.search ? '…' : '') || '/' };
  } catch {
    return { host: '', path: url };
  }
}

const MARKER: Record<Step['kind'], string> = {
  nav: 'bg-sky-500',
  click: 'bg-foreground',
  input: 'bg-violet-500',
  idle: 'bg-transparent border border-dashed border-muted-foreground/60',
};

function StepRow({ step, t0, isFirstNav }: { step: Step; t0: number; isFirstNav: boolean }) {
  return (
    <li className="grid grid-cols-[2.75rem_auto_1fr] gap-x-3">
      <span className="text-right text-xs tabular-nums text-muted-foreground/70 leading-6 select-none">
        {mss(step.t - t0)}
      </span>
      <span className="relative flex justify-center w-3">
        <span className="absolute top-0 bottom-0 w-px bg-border" aria-hidden />
        <span className={`relative mt-[7px] h-2.5 w-2.5 rounded-full ${MARKER[step.kind]}`} aria-hidden />
      </span>
      <span className="text-sm leading-6 pb-2 min-w-0">
        {step.kind === 'nav' && (() => {
          const { host, path } = splitUrl(step.url);
          return (
            <>
              <span className="text-muted-foreground">{isFirstNav ? 'Landed on ' : 'Went to '}</span>
              <span className="font-medium break-all">{path}</span>
              {host && <span className="text-xs text-muted-foreground/70 ml-1.5">{host}</span>}
            </>
          );
        })()}
        {step.kind === 'click' && (
          <>
            <span className="text-muted-foreground">Clicked </span>
            <span className="font-medium">&ldquo;{step.label}&rdquo;</span>
          </>
        )}
        {step.kind === 'input' && (
          <>
            <span className="text-muted-foreground">Typed in </span>
            <span className="font-medium">{step.field}</span>
          </>
        )}
        {step.kind === 'idle' && (
          <span className="text-muted-foreground italic">
            {step.ms > 0 ? `Idle for ${mss(step.ms)}` : '⋯'}
          </span>
        )}
      </span>
    </li>
  );
}

export function SessionSummary({ sessionId, initial, llmEnabled }: {
  sessionId: string; initial: SummaryData | null; llmEnabled: boolean;
}) {
  const [data, setData] = useState(initial);
  const [busy, setBusy] = useState(false);
  const waiting = llmEnabled && (!data || data.status === 'pending' || data.status === 'processing');

  // Poll while the digest or intent is still being generated.
  useEffect(() => {
    if (!waiting && data) return;
    const t = setInterval(async () => {
      const res = await fetch(`/api/admin/sessions/${sessionId}/summary`);
      if (res.ok) setData((await res.json()).summary);
    }, 5000);
    return () => clearInterval(t);
  }, [sessionId, waiting, data]);

  const regenerate = async () => {
    setBusy(true);
    await fetch(`/api/admin/sessions/${sessionId}/summary`, { method: 'POST' });
    setData((d) => (d ? { ...d, status: 'pending' } : d));
    setBusy(false);
  };

  if (!data) {
    return <Card className="p-4 text-sm text-muted-foreground">Summary is being generated…</Card>;
  }

  const t0 = data.steps[0]?.t ?? 0;
  let navSeen = 0;

  return (
    <Card className="p-0 overflow-hidden">
      {/* Header: title, provenance + signal chips, regenerate */}
      <div className="flex items-start justify-between gap-4 px-5 pt-4 pb-3">
        <div className="min-w-0">
          <h2 className="font-semibold">Session analysis</h2>
          <div className="flex flex-wrap items-center gap-1.5 mt-2">
            {data.intentText && (
              <span className="inline-flex items-center rounded-full bg-foreground text-background px-2.5 py-0.5 text-xs font-medium">
                AI analysis
              </span>
            )}
            {data.visualUsed && (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-foreground/25 px-2.5 py-0.5 text-xs font-medium">
                <span className="h-1.5 w-1.5 rounded-full bg-sky-500" aria-hidden />
                Visual analysis
              </span>
            )}
            {insightChips(data.insights).map((c) => (
              <span
                key={c.label}
                title={c.detail}
                className="inline-flex items-center rounded-full bg-amber-500/15 text-amber-700 dark:text-amber-400 px-2.5 py-0.5 text-xs font-medium"
              >
                {c.label}
              </span>
            ))}
          </div>
        </div>
        {llmEnabled && (
          <Button variant="outline" size="sm" onClick={regenerate} disabled={busy || waiting}>
            {waiting ? 'Generating…' : 'Regenerate'}
          </Button>
        )}
      </div>

      {/* Summary: emphasized reading block */}
      {llmEnabled && (
        <div className="px-5 pb-4">
          <div className="rounded-md bg-muted/50 border-l-2 border-foreground/70 px-4 py-3">
            <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground mb-1">Summary</div>
            <p className="text-sm leading-relaxed">
              {data.intentText ?? (data.status === 'failed'
                ? <span className="text-muted-foreground">AI summary unavailable for this session.</span>
                : <span className="text-muted-foreground">Interpreting this session…</span>)}
            </p>
          </div>
        </div>
      )}

      {/* Steps: structured timeline */}
      <div className="border-t px-5 py-4">
        <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground mb-3">Steps</div>
        {data.steps.length > 0 ? (
          <ol className="max-h-72 overflow-y-auto pr-1">
            {data.steps.map((s, i) => {
              const isFirstNav = s.kind === 'nav' && ++navSeen === 1;
              return <StepRow key={i} step={s} t0={t0} isFirstNav={isFirstNav} />;
            })}
          </ol>
        ) : (
          <pre className="text-xs text-muted-foreground whitespace-pre-wrap font-mono leading-5 max-h-64 overflow-y-auto">{data.narrative}</pre>
        )}
      </div>
    </Card>
  );
}
