import { redirect } from 'next/navigation';
import Link from 'next/link';
import { db, schema } from '@/lib/db';
import { and, eq, asc, desc, count, or, gt, lt, notExists, sql, getTableColumns } from 'drizzle-orm';
import { readSessionCookie } from '@/lib/auth';
import { viewedSessionIds } from '@/lib/session-views';
import { tagsForSessions } from '@/lib/session-tags';
import { summariesForSessions } from '@/lib/session-summaries';
import { profilesForVisitors } from '@/lib/user-profiles';
import { SummaryCell } from '@/components/summary-cell';
import type { TagColor } from '@/lib/tag-colors';
import { RefreshOnReturn } from '@/components/refresh-on-return';
import { Card } from '@/components/ui/card';
import { HeaderRule } from '@/components/header-rule';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { DeleteSessionButton } from '@/components/delete-session-button';
import { RangeTabs, resolveRange, rangeCutoff } from '@/components/range-tabs';
import { MarkAllViewedButton } from '@/components/mark-all-viewed-button';
import { SortableHead } from '@/components/sortable-head';
import { resolveSort, sortHref, type SortDir } from '@/lib/table-sort';
import { Pagination } from '@/components/pagination';

const PAGE_SIZE = 50;

const SORT_COLUMNS = ['when', 'duration', 'pages', 'country', 'browser'] as const;
type SortColumn = (typeof SORT_COLUMNS)[number];

const SORT_EXPR: Record<SortColumn, typeof schema.sessions.startedAt | typeof schema.sessions.durationMs | typeof schema.sessions.pageCount | typeof schema.sessions.country | typeof schema.sessions.browser> = {
  when: schema.sessions.startedAt,
  duration: schema.sessions.durationMs,
  pages: schema.sessions.pageCount,
  country: schema.sessions.country,
  browser: schema.sessions.browser,
};
const SORT_DEFAULT_DIR: Record<SortColumn, SortDir> = {
  when: 'desc', duration: 'desc', pages: 'desc', country: 'asc', browser: 'asc',
};

function fmtDuration(ms: number | null) {
  if (!ms) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

export default async function SessionsPage(props: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ user?: string; range?: string; sort?: string; dir?: string; page?: string; from?: string; to?: string }>;
}) {
  const { id } = await props.params;
  const { user, range: rangeParam, sort: sortParam, dir: dirParam, page: pageParam, from: fromParam, to: toParam } = await props.searchParams;
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
  // Explicit time slice (from the Timeline's click-through) beats the
  // relative range tabs.
  const sliceFrom = fromParam && !isNaN(Date.parse(fromParam)) ? new Date(fromParam) : null;
  const sliceTo = toParam && !isNaN(Date.parse(toParam)) ? new Date(toParam) : null;
  if (sliceFrom && sliceTo) {
    filters.push(gt(schema.sessions.startedAt, sliceFrom), lt(schema.sessions.startedAt, sliceTo));
  } else if (cutoff) filters.push(gt(schema.sessions.startedAt, cutoff));
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

  // "Ongoing" mirrors the summary sweeper's liveness rule exactly (no end
  // beacon + activity within 6 min — the tracker's 5-min resume TTL plus
  // slack; see ABANDONED_AFTER_MS), so this column and the pipeline
  // never disagree about whether a session is over.
  // Never pull blob_data into the list — 50 gzipped replay blobs per
  // page view is the most expensive no-op in the app.
  const { blobData: _blobData, ...sessionListColumns } = getTableColumns(schema.sessions);
  const rows = await db.select({
    ...sessionListColumns,
    ongoing: sql<boolean>`(${schema.sessions.endedAt} IS NULL AND ${schema.sessions.lastActivityAt} > now() - interval '6 minutes')`,
  }).from(schema.sessions).where(where).orderBy(orderExpr)
    .limit(PAGE_SIZE).offset((currentPage - 1) * PAGE_SIZE);

  // Which of the rows shown has the current admin already viewed?
  const viewedByMe = await viewedSessionIds(rows.map((r) => r.id), session.email);
  const tagsBySession = await tagsForSessions(rows.map((r) => r.id));
  const summariesBySession = await summariesForSessions(rows.map((r) => r.id));
  // When the list is filtered to one visitor, lead with who they are.
  const visitorProfile = user ? (await profilesForVisitors(id, [user])).get(user) : undefined;

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
            {sliceFrom && sliceTo ? <> · {new Date(sliceFrom).toLocaleString('en-GB')} – {new Date(sliceTo).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })} · <Link href={basePath} className="underline">clear</Link></> : null}
          </p>
        </div>
      </div>

      <HeaderRule />

      {user && visitorProfile?.profileText && (
        <Card className="p-4">
          <div className="rounded-md bg-muted/50 border-l-2 border-foreground/70 px-4 py-3">
            <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground mb-1">
              Visitor profile · from {visitorProfile.sessionsSummarized} summarized sessions
            </div>
            <p className="text-sm leading-relaxed max-w-4xl m-0">{visitorProfile.profileText}</p>
          </div>
        </Card>
      )}

      <div className="flex items-center justify-between gap-3">
        <RangeTabs basePath={basePath} currentRange={activeRange.value} extraParams={{ user }} />
        <MarkAllViewedButton projectId={id} unviewedCount={unviewed} />
      </div>

      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <SortableHead href={colHref('when')} active={sort.column === 'when'} dir={sort.dir}>When</SortableHead>
              <TableHead>State</TableHead>
              <TableHead>User</TableHead>
              <TableHead>Tags</TableHead>
              <TableHead>Summary</TableHead>
              <SortableHead href={colHref('duration')} active={sort.column === 'duration'} dir={sort.dir}>Duration</SortableHead>
              <SortableHead href={colHref('pages')} active={sort.column === 'pages'} dir={sort.dir}>Pages</SortableHead>
              <SortableHead href={colHref('country')} active={sort.column === 'country'} dir={sort.dir}>Country</SortableHead>
              <SortableHead href={colHref('browser')} active={sort.column === 'browser'} dir={sort.dir}>Browser</SortableHead>
              <TableHead className="w-12"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 && (
              <TableRow><TableCell colSpan={10} className="text-center text-muted-foreground py-8">
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
                <TableCell>
                  {s.ongoing ? (
                    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                      <span className="relative flex h-2 w-2">
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-500 opacity-60" />
                        <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
                      </span>
                      Ongoing
                    </span>
                  ) : (
                    <span className="text-xs text-muted-foreground">Done</span>
                  )}
                </TableCell>
                <TableCell className={unread ? 'font-semibold' : undefined}>
                  {s.email || s.userId || <span className="text-muted-foreground font-normal">Anonymous {s.anonId.slice(0, 8)}</span>}
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-1">
                    {(tagsBySession.get(s.id) ?? []).map((t) => (
                      <Badge key={t.id} variant={t.color as TagColor}>{t.name}</Badge>
                    ))}
                  </div>
                </TableCell>
                <TableCell>
                  <SummaryCell text={summariesBySession.get(s.id)?.intentText ?? summariesBySession.get(s.id)?.narrative.replace(/\n/g, ' → ') ?? null} />
                </TableCell>
                <TableCell>{fmtDuration(s.durationMs)}</TableCell>
                <TableCell>{s.pageCount}</TableCell>
                <TableCell>{s.country || '—'}</TableCell>
                <TableCell>{s.browser || '—'}</TableCell>
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
