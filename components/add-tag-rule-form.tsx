'use client';
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ColorDots } from '@/components/color-dots';
import type { TagColor } from '@/lib/tag-colors';

export function AddTagRuleForm({ projectId }: { projectId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'url_contains' | 'session_count_gte'>('url_contains');
  const [value, setValue] = useState('');
  const [color, setColor] = useState<TagColor>('green');
  const [error, setError] = useState<string | null>(null);
  const [applied, setApplied] = useState<number | null>(null);

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
      setValue('');
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
          onChange={(e) => setKind(e.target.value as typeof kind)}
          className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
        >
          <option value="url_contains">URL contains</option>
          <option value="session_count_gte">Session count ≥</option>
        </select>
      </div>
      <div className="space-y-1">
        <Label htmlFor="tag-value">{kind === 'url_contains' ? 'Substring' : 'Threshold'}</Label>
        <Input
          id="tag-value"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={kind === 'url_contains' ? 'register' : '2'}
          type={kind === 'session_count_gte' ? 'number' : 'text'}
          min={kind === 'session_count_gte' ? 1 : undefined}
          required
          className="w-32"
        />
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
