'use client';
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ColorDots } from '@/components/color-dots';
import { RULE_KIND_META, RULE_KINDS, type RuleKind } from '@/lib/tag-rule-kinds';
import type { TagColor } from '@/lib/tag-colors';

export function AddTagRuleForm({ projectId }: { projectId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [name, setName] = useState('');
  const [kind, setKind] = useState<RuleKind>('url_contains');
  const [value, setValue] = useState('');
  const [color, setColor] = useState<TagColor>('green');
  const [error, setError] = useState<string | null>(null);
  const [applied, setApplied] = useState<number | null>(null);

  const meta = RULE_KIND_META[kind];

  const onKindChange = (next: RuleKind) => {
    setKind(next);
    // A select-type value from a different kind (e.g. leftover "mobile"
    // when switching to source_is) would silently fail validation —
    // reset to that kind's own first option, or blank for free text.
    const nextMeta = RULE_KIND_META[next];
    setValue(nextMeta.valueType === 'select' ? nextMeta.options?.[0] ?? '' : '');
  };

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setApplied(null);
    start(async () => {
      const res = await fetch(`/api/admin/projects/${projectId}/tag-rules`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, kind, value, color }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => null);
        setError(j?.error ?? 'Failed to create rule');
        return;
      }
      const j = await res.json();
      setApplied(j.appliedCount ?? 0);
      setName('');
      setValue(meta.valueType === 'select' ? meta.options?.[0] ?? '' : '');
      router.refresh();
    });
  };

  return (
    <form onSubmit={onSubmit} className="flex flex-wrap items-end gap-3 rounded-lg border p-3">
      <div className="space-y-1">
        <Label htmlFor="tag-name">Name</Label>
        <Input id="tag-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Signed up" required className="w-40" />
      </div>
      <div className="space-y-1">
        <Label htmlFor="tag-kind">Kind</Label>
        <select
          id="tag-kind"
          value={kind}
          onChange={(e) => onKindChange(e.target.value as RuleKind)}
          className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
        >
          {RULE_KINDS.map((k) => <option key={k} value={k}>{RULE_KIND_META[k].label}</option>)}
        </select>
      </div>
      <div className="space-y-1">
        <Label htmlFor="tag-value">{meta.valueLabel}</Label>
        {meta.valueType === 'select' ? (
          <select
            id="tag-value"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="h-8 w-32 rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
          >
            {meta.options?.map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        ) : (
          <Input
            id="tag-value"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={meta.placeholder}
            type={meta.valueType === 'number' ? 'number' : 'text'}
            min={meta.valueType === 'number' ? 1 : undefined}
            required
            className="w-32"
          />
        )}
      </div>
      <div className="space-y-1">
        <Label>Color</Label>
        <div className="flex h-8 items-center">
          <ColorDots value={color} onChange={setColor} disabled={pending} />
        </div>
      </div>
      <Button type="submit" disabled={pending} size="sm">
        {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
        Add tag
      </Button>
      {error && <p className="w-full text-xs text-destructive">{error}</p>}
      {applied !== null && !error && (
        <p className="w-full text-xs text-muted-foreground">Tagged {applied} existing session{applied === 1 ? '' : 's'}.</p>
      )}
    </form>
  );
}
