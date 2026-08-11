/**
 * URL-param-driven column sorting for admin table pages — mirrors the
 * RangeTabs pattern (server-rendered links that set a query param,
 * no client JS needed).
 */
export type SortDir = 'asc' | 'desc';

export interface SortState<T extends string> {
  column: T;
  dir: SortDir;
}

/** Resolve ?sort=&dir= against a table's known sortable columns, falling
 * back to the table's default order when absent or invalid. */
export function resolveSort<T extends string>(
  params: { sort?: string; dir?: string },
  columns: readonly T[],
  fallback: SortState<T>,
): SortState<T> {
  const column = (columns as readonly string[]).includes(params.sort ?? '') ? (params.sort as T) : fallback.column;
  const dir: SortDir = params.dir === 'asc' || params.dir === 'desc' ? params.dir : fallback.dir;
  return { column, dir };
}

/** Build the href a column header should link to: toggles direction if
 * it's already the active column, otherwise switches to that column at
 * its own default direction (e.g. dates/counts start desc, text starts asc). */
export function sortHref(
  basePath: string,
  extraParams: Record<string, string | undefined>,
  current: SortState<string>,
  column: string,
  defaultDir: SortDir,
): string {
  const nextDir: SortDir = current.column === column ? (current.dir === 'asc' ? 'desc' : 'asc') : defaultDir;
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(extraParams)) if (v) p.set(k, v);
  p.set('sort', column);
  p.set('dir', nextDir);
  return `${basePath}?${p.toString()}`;
}
