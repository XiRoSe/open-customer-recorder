'use client';
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';

export function ExcludeUserButton({ projectId, anonId, excluded }: { projectId: string; anonId: string; excluded: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const onClick = () => {
    setError(null);
    start(async () => {
      const res = excluded
        ? await fetch(`/api/admin/projects/${projectId}/excluded-users/${encodeURIComponent(anonId)}`, { method: 'DELETE' })
        : await fetch(`/api/admin/projects/${projectId}/excluded-users`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ anonId }),
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
      title={error ?? (excluded ? 'Stop excluding — resume recording future sessions' : 'Exclude — stop recording future sessions from this browser')}
      className={
        excluded
          ? 'inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-medium text-destructive hover:bg-destructive/10 disabled:opacity-50'
          : 'inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-muted disabled:opacity-50'
      }
    >
      {pending && <Loader2 className="h-3 w-3 animate-spin" />}
      {excluded ? 'Excluded' : 'Exclude'}
    </button>
  );
}
