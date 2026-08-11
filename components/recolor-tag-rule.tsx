'use client';
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { ColorDots } from '@/components/color-dots';
import type { TagColor } from '@/lib/tag-colors';

export function RecolorTagRule({ projectId, ruleId, color }: { projectId: string; ruleId: string; color: TagColor }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const onChange = (next: TagColor) => {
    if (next === color) return;
    setError(null);
    start(async () => {
      const res = await fetch(`/api/admin/projects/${projectId}/tag-rules/${ruleId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ color: next }),
      });
      if (!res.ok) {
        setError('Failed to recolor');
        return;
      }
      router.refresh();
    });
  };

  return (
    <div title={error ?? undefined}>
      <ColorDots value={color} onChange={onChange} disabled={pending} />
    </div>
  );
}
