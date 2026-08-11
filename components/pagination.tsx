import Link from 'next/link';

interface Props {
  basePath: string;
  currentPage: number;
  totalPages: number;
  extraParams?: Record<string, string | undefined>;
}

function hrefFor(basePath: string, extraParams: Record<string, string | undefined>, page: number) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(extraParams)) if (v) p.set(k, v);
  // Omit `page` for page 1 so the canonical "fresh visit" URL stays short,
  // matching the RangeTabs convention for its own default.
  if (page > 1) p.set('page', String(page));
  const qs = p.toString();
  return qs ? `${basePath}?${qs}` : basePath;
}

export function Pagination({ basePath, currentPage, totalPages, extraParams }: Props) {
  if (totalPages <= 1) return null;

  // First, last, and a window of two pages either side of current —
  // collapse the gaps into an ellipsis rather than listing every page.
  const keep = new Set<number>([1, totalPages]);
  for (let p = currentPage - 2; p <= currentPage + 2; p++) {
    if (p >= 1 && p <= totalPages) keep.add(p);
  }
  const sorted = [...keep].sort((a, b) => a - b);
  const items: (number | 'ellipsis')[] = [];
  for (let i = 0; i < sorted.length; i++) {
    if (i > 0 && sorted[i] - sorted[i - 1] > 1) items.push('ellipsis');
    items.push(sorted[i]);
  }

  const navClass = (disabled: boolean) =>
    disabled
      ? 'px-2.5 py-1 rounded-md text-muted-foreground/40 pointer-events-none'
      : 'px-2.5 py-1 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors';

  return (
    <nav className="flex items-center gap-1 text-sm" aria-label="Pagination">
      <Link
        href={hrefFor(basePath, extraParams ?? {}, Math.max(1, currentPage - 1))}
        aria-disabled={currentPage === 1}
        className={navClass(currentPage === 1)}
      >
        Prev
      </Link>
      {items.map((it, i) =>
        it === 'ellipsis' ? (
          <span key={`e${i}`} className="px-1 text-muted-foreground">…</span>
        ) : (
          <Link
            key={it}
            href={hrefFor(basePath, extraParams ?? {}, it)}
            aria-current={it === currentPage ? 'page' : undefined}
            className={
              it === currentPage
                ? 'px-3 py-1 rounded-md bg-foreground text-background font-medium'
                : 'px-3 py-1 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors'
            }
          >
            {it}
          </Link>
        ),
      )}
      <Link
        href={hrefFor(basePath, extraParams ?? {}, Math.min(totalPages, currentPage + 1))}
        aria-disabled={currentPage === totalPages}
        className={navClass(currentPage === totalPages)}
      >
        Next
      </Link>
    </nav>
  );
}
