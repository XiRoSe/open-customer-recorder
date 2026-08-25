'use client';

import { useState } from 'react';
import { Card } from '@/components/ui/card';

/** Retention window + per-session recording cap, saved per project. */
export function DataSettings({ projectId, initialRetentionDays, initialMaxSessionMinutes }: {
  projectId: string;
  initialRetentionDays: number;
  initialMaxSessionMinutes: number;
}) {
  const [retentionDays, setRetentionDays] = useState(initialRetentionDays);
  const [maxSessionMinutes, setMaxSessionMinutes] = useState(initialMaxSessionMinutes);
  // Baseline advances on every successful save, so edits can always be
  // reverted-and-saved without a page reload.
  const [baseline, setBaseline] = useState({ retentionDays: initialRetentionDays, maxSessionMinutes: initialMaxSessionMinutes });
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [error, setError] = useState('');

  const dirty = retentionDays !== baseline.retentionDays || maxSessionMinutes !== baseline.maxSessionMinutes;

  const save = async () => {
    setState('saving');
    setError('');
    try {
      const res = await fetch(`/api/admin/projects/${projectId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ retentionDays, maxSessionMinutes }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `save failed (${res.status})`);
      }
      setBaseline({ retentionDays, maxSessionMinutes });
      setState('saved');
      setTimeout(() => setState('idle'), 2500);
    } catch (e) {
      setState('error');
      setError(e instanceof Error ? e.message : 'save failed');
    }
  };

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-end gap-6">
        <label className="block">
          <span className="block text-sm font-medium mb-1" title="Sessions (and their replays) older than this are deleted. Visitor profiles are kept — insights outlive the raw data.">
            Retention (days)
          </span>
          <input
            type="number" min={1} max={365} value={retentionDays}
            onChange={(e) => setRetentionDays(parseInt(e.target.value, 10) || 0)}
            className="w-28 rounded-md border px-3 py-1.5 text-sm tabular-nums bg-background"
          />
        </label>
        <label className="block">
          <span className="block text-sm font-medium mb-1" title="Hard cap on one recorded session's length. Running trackers pick the new value up within a minute; longer visits continue as fresh sessions.">
            Max session length (minutes)
          </span>
          <input
            type="number" min={1} max={60} value={maxSessionMinutes}
            onChange={(e) => setMaxSessionMinutes(parseInt(e.target.value, 10) || 0)}
            className="w-28 rounded-md border px-3 py-1.5 text-sm tabular-nums bg-background"
          />
        </label>
        <button
          type="button"
          onClick={save}
          disabled={!dirty || state === 'saving'}
          className="rounded-md bg-foreground text-background px-4 py-1.5 text-sm font-medium disabled:opacity-40"
        >
          {state === 'saving' ? 'Saving…' : 'Save'}
        </button>
        {state === 'saved' && <span className="text-sm text-emerald-700">Saved</span>}
        {state === 'error' && <span className="text-sm text-rose-600">{error}</span>}
      </div>
    </Card>
  );
}
