'use client';
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { CheckCheck, Loader2 } from 'lucide-react';

export function MarkAllViewedButton({ projectId, unviewedCount }: { projectId: string; unviewedCount: number }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);

  if (unviewedCount === 0) return null;

  const onClick = () => {
    setErr(null);
    start(async () => {
      const res = await fetch(`/api/admin/projects/${projectId}/mark-viewed`, { method: 'POST' });
      if (!res.ok) {
        setErr('Failed');
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
      title={err ?? `Mark ${unviewedCount} unviewed sessions as viewed`}
      className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground transition-colors disabled:opacity-50"
    >
      {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCheck className="h-3.5 w-3.5" />}
      Mark all as viewed
    </button>
  );
}
