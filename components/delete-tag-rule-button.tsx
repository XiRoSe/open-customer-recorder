'use client';
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Trash2, Loader2 } from 'lucide-react';

export function DeleteTagRuleButton({ projectId, ruleId, name }: { projectId: string; ruleId: string; name: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const onClick = () => {
    if (!confirm(`Delete the "${name}" tag rule? This removes it from every session it's tagged — this cannot be undone.`)) return;
    setError(null);
    start(async () => {
      const res = await fetch(`/api/admin/projects/${projectId}/tag-rules/${ruleId}`, { method: 'DELETE' });
      if (!res.ok) {
        setError('Failed to delete');
        return;
      }
      router.refresh();
    });
  };

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={pending}
      title={error ?? 'Delete this rule'}
      aria-label="Delete tag rule"
      className="inline-flex items-center justify-center rounded p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors disabled:opacity-50"
    >
      {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
    </button>
  );
}
