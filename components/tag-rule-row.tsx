'use client';
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Pencil, Check, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { TableCell, TableRow } from '@/components/ui/table';
import { RecolorTagRule } from '@/components/recolor-tag-rule';
import { ToggleTagRuleButton } from '@/components/toggle-tag-rule-button';
import { DeleteTagRuleButton } from '@/components/delete-tag-rule-button';
import { describeRule, RULE_KIND_META, type RuleKind } from '@/lib/tag-rule-kinds';
import type { TagColor } from '@/lib/tag-colors';

export interface TagRuleRowData {
  id: string;
  name: string;
  kind: string;
  value: string;
  color: string;
  enabled: boolean;
  taggedCount: number;
}

export function TagRuleRow({ projectId, rule }: { projectId: string; rule: TagRuleRowData }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [pending, start] = useTransition();
  const [name, setName] = useState(rule.name);
  const [value, setValue] = useState(rule.value);
  const [error, setError] = useState<string | null>(null);

  const meta = RULE_KIND_META[rule.kind as RuleKind] as (typeof RULE_KIND_META)[RuleKind] | undefined;

  const cancel = () => {
    setName(rule.name);
    setValue(rule.value);
    setError(null);
    setEditing(false);
  };

  const save = () => {
    const trimmedName = name.trim();
    const trimmedValue = value.trim();
    if (!trimmedName || !trimmedValue) {
      setError('Name and value are required');
      return;
    }
    setError(null);
    start(async () => {
      const res = await fetch(`/api/admin/projects/${projectId}/tag-rules/${rule.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: trimmedName, value: trimmedValue }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => null);
        setError(j?.error ?? 'Failed to save');
        return;
      }
      setEditing(false);
      router.refresh();
    });
  };

  if (editing) {
    return (
      <TableRow>
        <TableCell>
          <Input value={name} onChange={(e) => setName(e.target.value)} className="h-8 w-32" autoFocus />
        </TableCell>
        <TableCell>
          {meta?.valueType === 'select' ? (
            <select
              value={value}
              onChange={(e) => setValue(e.target.value)}
              className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
            >
              {meta.options?.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
          ) : (
            <Input
              value={value}
              onChange={(e) => setValue(e.target.value)}
              type={meta?.valueType === 'number' ? 'number' : 'text'}
              className="h-8 w-28 font-mono text-xs"
            />
          )}
          {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
        </TableCell>
        <TableCell colSpan={3}>
          <div className="flex items-center gap-1">
            <Button type="button" size="sm" variant="ghost" onClick={save} disabled={pending} aria-label="Save">
              {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={cancel} disabled={pending} aria-label="Cancel">
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        </TableCell>
      </TableRow>
    );
  }

  return (
    <TableRow>
      <TableCell><Badge variant={rule.color as TagColor}>{rule.name}</Badge></TableCell>
      <TableCell className="font-mono text-xs text-muted-foreground">{describeRule(rule.kind, rule.value)}</TableCell>
      <TableCell>
        <RecolorTagRule projectId={projectId} ruleId={rule.id} color={rule.color as TagColor} />
      </TableCell>
      <TableCell>{rule.taggedCount}</TableCell>
      <TableCell>
        <div className="flex items-center gap-1">
          <ToggleTagRuleButton projectId={projectId} ruleId={rule.id} enabled={rule.enabled} />
          <button
            type="button"
            onClick={() => setEditing(true)}
            title="Edit name and value"
            aria-label="Edit tag rule"
            className="inline-flex items-center justify-center rounded p-1.5 text-muted-foreground hover:bg-muted transition-colors"
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
          <DeleteTagRuleButton projectId={projectId} ruleId={rule.id} name={rule.name} />
        </div>
      </TableCell>
    </TableRow>
  );
}
