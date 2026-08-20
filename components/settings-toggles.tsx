'use client';

import { useState } from 'react';
import { Card } from '@/components/ui/card';
import type { AppSettings } from '@/lib/app-settings';

const FEATURES: { key: keyof AppSettings; title: string; description: string }[] = [
  {
    key: 'summariesEnabled',
    title: 'Session narratives',
    description: 'Digest every finished session into a step-by-step story and frustration insights. Free — runs in-app, no model involved.',
  },
  {
    key: 'intentEnabled',
    title: 'AI intent summaries',
    description: 'Send each digest to the self-hosted summarizer for a 2-3 sentence read on what the visitor wanted. Requires the summarizer service.',
  },
  {
    key: 'visualEnabled',
    title: 'Visual analysis',
    description: 'Attach up to two replay screenshots to the AI call so the summary can mention what the visitor actually saw. Adds ~20s per session.',
  },
];

export function SettingsToggles({ initial }: { initial: AppSettings }) {
  const [settings, setSettings] = useState(initial);
  const [saving, setSaving] = useState<string | null>(null);

  const toggle = async (key: keyof AppSettings) => {
    setSaving(key);
    const next = !settings[key];
    const res = await fetch('/api/admin/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ [key]: next }),
    });
    if (res.ok) setSettings((await res.json()).settings);
    setSaving(null);
  };

  return (
    <Card className="divide-y p-0">
      {FEATURES.map((f) => (
        <div key={f.key} className="flex items-center justify-between gap-6 p-4">
          <div>
            <div className="font-medium">{f.title}</div>
            <p className="text-sm text-muted-foreground">{f.description}</p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={settings[f.key]}
            aria-label={f.title}
            disabled={saving === f.key}
            onClick={() => toggle(f.key)}
            className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${settings[f.key] ? 'bg-primary' : 'bg-muted-foreground/30'} ${saving === f.key ? 'opacity-50' : ''}`}
          >
            <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${settings[f.key] ? 'left-[22px]' : 'left-0.5'}`} />
          </button>
        </div>
      ))}
    </Card>
  );
}
