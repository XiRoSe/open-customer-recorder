import { redirect } from 'next/navigation';
import Link from 'next/link';
import { db, schema } from '@/lib/db';
import { and, eq, sql, asc, desc, count, sum, max, gt } from 'drizzle-orm';
import { readSessionCookie } from '@/lib/auth';
import { Card } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { RangeTabs, resolveRange, rangeCutoff } from '@/components/range-tabs';
import { ExcludeUserButton } from '@/components/exclude-user-button';
import { excludedAnonIdsAmong } from '@/lib/excluded-users';
import { SortableHead } from '@/components/sortable-head';
import { resolveSort, sortHref, type SortDir } from '@/lib/table-sort';

const SORT_COLUMNS = ['sessions', 'time', 'lastSeen', 'country', 'browser'] as const;
type SortColumn = (typeof SORT_COLUMNS)[number];
const SORT_DEFAULT_DIR: Record<SortColumn, SortDir> = {
  sessions: 'desc', time: 'desc', lastSeen: 'desc', country: 'asc', browser: 'asc',
};

function fmtDuration(ms: number | null) {
  if (!ms) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export default async function UsersPage(props: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ range?: string; sort?: string; dir?: string }>;
}) {
  const { id } = await props.params;
  const { range: rangeParam, sort: sortParam, dir: dirParam } = await props.searchParams;
  const session = await readSessionCookie();
  if (!session) redirect('/login');

  const [project] = await db.select().from(schema.projects)
    .where(and(eq(schema.projects.id, id), eq(schema.projects.orgId, session.orgId)));
  if (!project) redirect('/projects');

  const activeRange = resolveRange(rangeParam);
  const cutoff = rangeCutoff(rangeParam);
  const sort = resolveSort({ sort: sortParam, dir: dirParam }, SORT_COLUMNS, { column: 'lastSeen', dir: 'desc' });

  // Aggregate sessions by anonId (or userId if set, else anonId).
  // The range filter restricts BOTH the user list AND the per-user
  // session_count/total_duration aggregates — a user with no activity
  // in the chosen window drops out of the list entirely.
  const filters = [
    eq(schema.sessions.projectId, id),
    gt(schema.sessions.eventCount, 0),
  ];
  if (cutoff) filters.push(gt(schema.sessions.startedAt, cutoff));

  // Named so the same aggregate expression can drive both the selected
  // column and its ORDER BY when that column is the active sort.
  const countryAgg = max(schema.sessions.country);
  const browserAgg = max(schema.sessions.browser);
  const sessionCountAgg = count();
  const totalDurationAgg = sum(schema.sessions.durationMs);
  const lastSeenAgg = max(schema.sessions.lastActivityAt);
  const SORT_EXPR: Record<SortColumn, typeof countryAgg | typeof sessionCountAgg | typeof totalDurationAgg | typeof lastSeenAgg> = {
    sessions: sessionCountAgg,
    time: totalDurationAgg,
    lastSeen: lastSeenAgg,
    country: countryAgg,
    browser: browserAgg,
  };
  const orderExpr = sort.dir === 'asc' ? asc(SORT_EXPR[sort.column]) : desc(SORT_EXPR[sort.column]);

  const rows = await db
    .select({
      key: sql<string>`coalesce(${schema.sessions.userId}, ${schema.sessions.anonId})`,
      anonId: schema.sessions.anonId,
      userId: schema.sessions.userId,
      email: max(schema.sessions.email),
      displayName: max(schema.sessions.displayName),
      country: countryAgg,
      browser: browserAgg,
      sessionCount: sessionCountAgg,
      totalDuration: totalDurationAgg,
      lastSeen: lastSeenAgg,
    })
    .from(schema.sessions)
    .where(and(...filters))
    .groupBy(sql`coalesce(${schema.sessions.userId}, ${schema.sessions.anonId})`, schema.sessions.anonId, schema.sessions.userId)
    .orderBy(orderExpr)
    .limit(100);

  const excludedAnonIds = await excludedAnonIdsAmong(id, rows.map((r) => r.anonId));

  const basePath = `/projects/${id}/users`;
  const sessionsHrefBase = `/projects/${id}/sessions`;
  const colHref = (column: SortColumn) => sortHref(basePath, { range: rangeParam }, sort, column, SORT_DEFAULT_DIR[column]);
  const sessionLink = (userKey: string) => {
    const p = new URLSearchParams({ user: userKey });
    if (activeRange.value !== '24h') p.set('range', activeRange.value);
    return `${sessionsHrefBase}?${p.toString()}`;
  };

  return (
    <main className="max-w-6xl mx-auto p-6 space-y-4">
      <div className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-semibold">{project.name} Users</h1>
          <p className="text-sm text-muted-foreground">
            {rows.length.toLocaleString()} {rows.length === 1 ? 'user' : 'users'}
            {activeRange.hours !== null ? <> active in the last {activeRange.label}</> : null}
          </p>
        </div>
        <div className="flex gap-2 text-sm">
          <Link href={`${sessionsHrefBase}${activeRange.value === '24h' ? '' : `?range=${activeRange.value}`}`} className="text-muted-foreground hover:underline">Sessions</Link>
          <span className="text-muted-foreground">·</span>
          <span className="font-medium">Users</span>
          <span className="text-muted-foreground">·</span>
          <Link href={`/projects/${id}/tags`} className="text-muted-foreground hover:underline">Tags</Link>
        </div>
      </div>

      <RangeTabs basePath={basePath} currentRange={activeRange.value} />

      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>User</TableHead>
              <SortableHead href={colHref('sessions')} active={sort.column === 'sessions'} dir={sort.dir}>Sessions</SortableHead>
              <SortableHead href={colHref('time')} active={sort.column === 'time'} dir={sort.dir}>Total time</SortableHead>
              <SortableHead href={colHref('lastSeen')} active={sort.column === 'lastSeen'} dir={sort.dir}>Last seen</SortableHead>
              <SortableHead href={colHref('country')} active={sort.column === 'country'} dir={sort.dir}>Country</SortableHead>
              <SortableHead href={colHref('browser')} active={sort.column === 'browser'} dir={sort.dir}>Browser</SortableHead>
              <TableHead>Recording</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 && (
              <TableRow><TableCell colSpan={7} className="text-center text-muted-foreground py-8">
                {activeRange.hours !== null
                  ? <>No users active in the last {activeRange.label}. <Link href={`${basePath}?range=all`} className="underline">Show all time</Link>.</>
                  : 'No users yet.'}
              </TableCell></TableRow>
            )}
            {rows.map((u) => (
              <TableRow key={u.key}>
                <TableCell>
                  <Link href={sessionLink(u.key)} className="hover:underline">
                    {u.email || u.displayName || u.userId || (
                      <span className="text-muted-foreground">Anonymous {u.anonId.slice(0, 8)}</span>
                    )}
                  </Link>
                </TableCell>
                <TableCell>{u.sessionCount}</TableCell>
                <TableCell>{fmtDuration(u.totalDuration ? Number(u.totalDuration) : null)}</TableCell>
                <TableCell>{u.lastSeen ? new Date(u.lastSeen).toLocaleString('en-GB') : '—'}</TableCell>
                <TableCell>{u.country || '—'}</TableCell>
                <TableCell>{u.browser || '—'}</TableCell>
                <TableCell>
                  <ExcludeUserButton projectId={id} anonId={u.anonId} excluded={excludedAnonIds.has(u.anonId)} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    </main>
  );
}
