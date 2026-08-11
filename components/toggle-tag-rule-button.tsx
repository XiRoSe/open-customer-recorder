'use client';
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';

export function ToggleTagRuleButton({ projectId, ruleId, enabled }: { projectId: string; ruleId: string; enabled: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const onClick = () => {
    setError(null);
    start(async () => {
      const res = await fetch(`/api/admin/projects/${projectId}/tag-rules/${ruleId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: !enabled }),
      });
      if (!res.ok) {
        setError('Failed');
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
      title={error ?? (enabled ? 'Disable this rule' : 'Enable this rule — reapplies to existing sessions')}
      className={
        enabled
          ? 'inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-medium text-foreground hover:bg-muted disabled:opacity-50'
          : 'inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-muted disabled:opacity-50'
      }
    >
      {pending && <Loader2 className="h-3 w-3 animate-spin" />}
      {enabled ? 'Enabled' : 'Disabled'}
    </button>
  );
}
