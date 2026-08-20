import { redirect } from 'next/navigation';
import Link from 'next/link';
import { db, schema } from '@/lib/db';
import { and, eq, asc, desc, count, or, gt, notExists } from 'drizzle-orm';
import { readSessionCookie } from '@/lib/auth';
import { viewedSessionIds } from '@/lib/session-views';
import { tagsForSessions } from '@/lib/session-tags';
import { insightsForSessions } from '@/lib/session-summaries';
import { INSIGHT_META } from '@/lib/insight-meta';
import type { TagColor } from '@/lib/tag-colors';
import { RefreshOnReturn } from '@/components/refresh-on-return';
import { Card } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { DeleteSessionButton } from '@/components/delete-session-button';
import { RangeTabs, resolveRange, rangeCutoff } from '@/components/range-tabs';
import { MarkAllViewedButton } from '@/components/mark-all-viewed-button';
import { SortableHead } from '@/components/sortable-head';
import { resolveSort, sortHref, type SortDir } from '@/lib/table-sort';
import { Pagination } from '@/components/pagination';

const PAGE_SIZE = 50;

const SORT_COLUMNS = ['when', 'duration', 'pages', 'country', 'browser', 'errors'] as const;
type SortColumn = (typeof SORT_COLUMNS)[number];

const SORT_EXPR: Record<SortColumn, typeof schema.sessions.startedAt | typeof schema.sessions.durationMs | typeof schema.sessions.pageCount | typeof schema.sessions.country | typeof schema.sessions.browser | typeof schema.sessions.hasErrors> = {
  when: schema.sessions.startedAt,
  duration: schema.sessions.durationMs,
  pages: schema.sessions.pageCount,
  country: schema.sessions.country,
  browser: schema.sessions.browser,
  errors: schema.sessions.hasErrors,
};
const SORT_DEFAULT_DIR: Record<SortColumn, SortDir> = {
  when: 'desc', duration: 'desc', pages: 'desc', country: 'asc', browser: 'asc', errors: 'desc',
};

function dedupeInsightKinds(insights: { kind: string }[]): { kind: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const i of insights) counts.set(i.kind, (counts.get(i.kind) || 0) + 1);
  return [...counts.entries()].map(([kind, count]) => ({ kind, count }));
}

function fmtDuration(ms: number | null) {
  if (!ms) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

export default async function SessionsPage(props: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ user?: string; range?: string; sort?: string; dir?: string; page?: string }>;
}) {
  const { id } = await props.params;
  const { user, range: rangeParam, sort: sortParam, dir: dirParam, page: pageParam } = await props.searchParams;
  const session = await readSessionCookie();
  if (!session) redirect('/login');
  const [project] = await db.select().from(schema.projects)
    .where(and(eq(schema.projects.id, id), eq(schema.projects.orgId, session.orgId)));
  if (!project) redirect('/projects');

  const activeRange = resolveRange(rangeParam);
  const cutoff = rangeCutoff(rangeParam);
  const sort = resolveSort({ sort: sortParam, dir: dirParam }, SORT_COLUMNS, { column: 'when', dir: 'desc' });
  const orderExpr = sort.dir === 'asc' ? asc(SORT_EXPR[sort.column]) : desc(SORT_EXPR[sort.column]);

  // Hide sessions with no captured events — they're not replayable.
  const filters = [
    eq(schema.sessions.projectId, id),
    gt(schema.sessions.eventCount, 0),
  ];
  if (cutoff) filters.push(gt(schema.sessions.startedAt, cutoff));
  if (user) {
    filters.push(
      or(eq(schema.sessions.userId, user), eq(schema.sessions.anonId, user))!,
    );
  }
  const where = and(...filters)!;

  // "Unviewed" is per-admin: a session with no session_views row for the
  // current admin. Correlated subquery against the outer sessions row.
  const unviewedByMe = notExists(
    db.select({ id: schema.sessionViews.id })
      .from(schema.sessionViews)
      .where(and(
        eq(schema.sessionViews.sessionId, schema.sessions.id),
        eq(schema.sessionViews.adminEmail, session.email),
      )),
  );

  // total/unviewed don't depend on the page, so resolve them first —
  // total tells us how many pages exist, which clamps an out-of-range
  // ?page= (e.g. left over after a filter change shrank the result set)
  // to the last valid page instead of silently rendering empty.
  const [[{ value: total }], [{ value: unviewed }]] = await Promise.all([
    db.select({ value: count() }).from(schema.sessions).where(where),
    // Count unviewed sessions in the SAME filter so the badge matches
    // what's visible — e.g. "8 unviewed in the last 24h", not project-wide.
    db.select({ value: count() }).from(schema.sessions).where(and(where, unviewedByMe)!),
  ]);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const requestedPage = Math.max(1, parseInt(pageParam ?? '1', 10) || 1);
  const currentPage = Math.min(requestedPage, totalPages);

  const rows = await db.select().from(schema.sessions).where(where).orderBy(orderExpr)
    .limit(PAGE_SIZE).offset((currentPage - 1) * PAGE_SIZE);

  // Which of the rows shown has the current admin already viewed?
  const viewedByMe = await viewedSessionIds(rows.map((r) => r.id), session.email);
  const tagsBySession = await tagsForSessions(rows.map((r) => r.id));
  const insightsBySession = await insightsForSessions(rows.map((r) => r.id));

  const basePath = `/projects/${id}/sessions`;
  const clearUserHref = activeRange.value === '24h' ? basePath : `${basePath}?range=${activeRange.value}`;
  const showAllTimeHref = user ? `${basePath}?user=${encodeURIComponent(user)}&range=all` : `${basePath}?range=all`;
  const colHref = (column: SortColumn) => sortHref(basePath, { user, range: rangeParam }, sort, column, SORT_DEFAULT_DIR[column]);

  return (
    <main className="max-w-6xl mx-auto p-6 space-y-4">
      <RefreshOnReturn />
      <div className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-semibold">{project.name} Sessions</h1>
          <p className="text-sm text-muted-foreground">
            {total.toLocaleString()} {total === 1 ? 'session' : 'sessions'}
            {activeRange.hours !== null ? <> in the last {activeRange.label}</> : null}
            {unviewed > 0 ? <> · <span className="font-medium text-foreground">{unviewed} unviewed</span></> : null}
            {user ? <> · filtered by <span className="font-mono">{user}</span> · <Link href={clearUserHref} className="underline">clear</Link></> : null}
          </p>
        </div>
        <div className="flex gap-2 text-sm items-baseline">
          <span className="font-medium">Sessions</span>
          <span className="text-muted-foreground">·</span>
          <Link href={`/projects/${id}/users${activeRange.value === '24h' ? '' : `?range=${activeRange.value}`}`} className="text-muted-foreground hover:underline">Users</Link>
          <span className="text-muted-foreground">·</span>
          <Link href={`/projects/${id}/tags`} className="text-muted-foreground hover:underline">Tags</Link>
        </div>
      </div>

      <div className="flex items-center justify-between gap-3">
        <RangeTabs basePath={basePath} currentRange={activeRange.value} extraParams={{ user }} />
        <MarkAllViewedButton projectId={id} unviewedCount={unviewed} />
      </div>

      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <SortableHead href={colHref('when')} active={sort.column === 'when'} dir={sort.dir}>When</SortableHead>
              <TableHead>User</TableHead>
              <TableHead>Tags</TableHead>
              <SortableHead href={colHref('duration')} active={sort.column === 'duration'} dir={sort.dir}>Duration</SortableHead>
              <SortableHead href={colHref('pages')} active={sort.column === 'pages'} dir={sort.dir}>Pages</SortableHead>
              <SortableHead href={colHref('country')} active={sort.column === 'country'} dir={sort.dir}>Country</SortableHead>
              <SortableHead href={colHref('browser')} active={sort.column === 'browser'} dir={sort.dir}>Browser</SortableHead>
              <SortableHead href={colHref('errors')} active={sort.column === 'errors'} dir={sort.dir}>Errors</SortableHead>
              <TableHead className="w-12"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 && (
              <TableRow><TableCell colSpan={9} className="text-center text-muted-foreground py-8">
                {activeRange.hours !== null
                  ? <>No sessions in the last {activeRange.label}. <Link href={showAllTimeHref} className="underline">Show all time</Link>.</>
                  : 'No sessions yet.'}
              </TableCell></TableRow>
            )}
            {rows.map((s) => {
              const unread = !viewedByMe.has(s.id);
              return (
              <TableRow key={s.id} className="cursor-pointer">
                <TableCell>
                  <Link
                    href={`/sessions/${s.id}`}
                    className={unread ? 'inline-flex items-center gap-2 font-semibold hover:underline' : 'inline-flex items-center gap-2 hover:underline'}
                  >
                    <span
                      aria-label={unread ? 'Unviewed' : 'Viewed'}
                      title={unread ? 'Unviewed' : 'Viewed'}
                      className={
                        unread
                          ? 'inline-block h-2 w-2 rounded-full bg-blue-500'
                          : 'inline-block h-2 w-2 rounded-full bg-transparent'
                      }
                    />
                    {new Date(s.startedAt).toLocaleString('en-GB')}
                  </Link>
                </TableCell>
                <TableCell className={unread ? 'font-semibold' : undefined}>
                  {s.email || s.userId || <span className="text-muted-foreground font-normal">Anonymous {s.anonId.slice(0, 8)}</span>}
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-1">
                    {(tagsBySession.get(s.id) ?? []).map((t) => (
                      <Badge key={t.id} variant={t.color as TagColor}>{t.name}</Badge>
                    ))}
                    {dedupeInsightKinds(insightsBySession.get(s.id) ?? []).map(({ kind, count }) => {
                      const meta = INSIGHT_META[kind] ?? { emoji: '•', label: kind };
                      return (
                        <Badge key={kind} variant="secondary" title={meta.label}>
                          {meta.emoji}{count > 1 ? ` ×${count}` : ''}
                        </Badge>
                      );
                    })}
                  </div>
                </TableCell>
                <TableCell>{fmtDuration(s.durationMs)}</TableCell>
                <TableCell>{s.pageCount}</TableCell>
                <TableCell>{s.country || '—'}</TableCell>
                <TableCell>{s.browser || '—'}</TableCell>
                <TableCell>{s.hasErrors ? <Badge variant="destructive">!</Badge> : '—'}</TableCell>
                <TableCell className="text-right">
                  <DeleteSessionButton sessionId={s.id} />
                </TableCell>
              </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </Card>

      <Pagination
        basePath={basePath}
        currentPage={currentPage}
        totalPages={totalPages}
        extraParams={{ user, range: rangeParam, sort: sortParam, dir: dirParam }}
      />
    </main>
  );
}
