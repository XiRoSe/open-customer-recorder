'use client';
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Trash2 } from 'lucide-react';

interface Props {
  sessionId: string;
  redirectTo?: string;
}

export function DeleteSessionButton({ sessionId, redirectTo }: Props) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const onClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (!confirm('Delete this session? This cannot be undone.')) return;
    setError(null);
    start(async () => {
      const res = await fetch(`/api/admin/sessions/${sessionId}`, { method: 'DELETE' });
      if (!res.ok) {
        setError('Failed to delete');
        return;
      }
      if (redirectTo) router.push(redirectTo);
      else router.refresh();
    });
  };

  return (
    <button
      onClick={onClick}
      disabled={pending}
      title={error ?? 'Delete session'}
      aria-label="Delete session"
      className="inline-flex items-center justify-center rounded p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors disabled:opacity-50"
    >
      <Trash2 className="h-4 w-4" />
    </button>
  );
}
