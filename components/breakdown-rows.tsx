'use client';

import { useEffect, useState } from 'react';

/** Count rows with a quiet share bar — the same visual language as the
 * Traffic sources card, in a neutral ink. The "+ N in smaller groups"
 * line opens a modal with the full scrollable list. */
export function BreakdownRows({ items, total, limit, labels, mono, listTitle }: {
  items: [string, number][];
  total: number;
  limit?: number;
  labels?: Record<string, string>;
  mono?: boolean;
  /** Heading of the full-list modal, e.g. "All entry pages". */
  listTitle?: string;
}) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const sorted = [...items].sort((a, b) => b[1] - a[1]);
  const top = sorted.slice(0, limit ?? sorted.length);
  const restCount = sorted.length - top.length;
  const rest = sorted.slice(top.length).reduce((a, [, n]) => a + n, 0);

  const Row = ({ k, n }: { k: string; n: number }) => {
    const share = Math.round((100 * n) / Math.max(1, total));
    return (
      <div className="flex items-center gap-3 text-sm">
        <span className={`w-40 truncate ${mono ? 'font-mono text-xs' : ''}`} title={labels?.[k] ?? k}>{labels?.[k] ?? k}</span>
        <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
          <div className="h-full rounded-full bg-foreground/60" style={{ width: `${share}%` }} />
        </div>
        <span className="tabular-nums text-muted-foreground w-20 text-right shrink-0">{n} · {share}%</span>
      </div>
    );
  };

  return (
    <div className="space-y-2.5">
      {top.map(([k, n]) => <Row key={k} k={k} n={n} />)}
      {rest > 0 && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="text-xs text-muted-foreground hover:text-foreground hover:underline cursor-pointer"
          title={`Show all ${sorted.length} ${listTitle?.toLowerCase() ?? 'entries'}`}
        >
          + {rest} in {restCount} smaller {restCount === 1 ? 'group' : 'groups'}
        </button>
      )}

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => setOpen(false)}
          role="dialog"
          aria-modal="true"
          aria-label={listTitle ?? 'Full list'}
        >
          <div
            className="w-full max-w-lg rounded-xl border bg-card p-4 shadow-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-3">
              <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                {listTitle ?? 'Full list'} · {sorted.length}
              </div>
              <button type="button" onClick={() => setOpen(false)}
                      className="text-sm text-muted-foreground hover:text-foreground px-1" aria-label="Close">✕</button>
            </div>
            <div className="space-y-2.5 max-h-[65vh] overflow-y-auto pr-1">
              {sorted.map(([k, n]) => <Row key={k} k={k} n={n} />)}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
