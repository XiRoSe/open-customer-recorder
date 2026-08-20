'use client';

import { useEffect, useState } from 'react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { Insight } from '@/lib/session-digest';
import { INSIGHT_META } from '@/lib/insight-meta';

export interface SummaryData {
  narrative: string;
  insights: Insight[];
  intentText: string | null;
  status: string;
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

  return (
    <Card className="p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold">What happened</h2>
        {llmEnabled && (
          <Button variant="outline" size="sm" onClick={regenerate} disabled={busy || waiting}>
            {waiting ? 'Generating…' : 'Regenerate'}
          </Button>
        )}
      </div>
      {data.insights.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {data.insights.map((i, idx) => {
            const meta = INSIGHT_META[i.kind] ?? { emoji: '•', label: i.kind };
            return (
              <Badge key={idx} variant="secondary" title={i.detail}>
                {meta.emoji} {meta.label}{i.count ? ` ×${i.count}` : ''}
              </Badge>
            );
          })}
        </div>
      )}
      {llmEnabled && (
        <p className="text-sm">
          {data.intentText ?? (data.status === 'failed'
            ? <span className="text-muted-foreground">Intent summary unavailable.</span>
            : <span className="text-muted-foreground">Interpreting…</span>)}
        </p>
      )}
      <pre className="text-xs text-muted-foreground whitespace-pre-wrap font-mono leading-5 max-h-64 overflow-y-auto">{data.narrative}</pre>
    </Card>
  );
}
