// The Researcher's tools: thin, org-scoped read wrappers over the same
// lib functions the pages use. No LLM here — every figure a tool returns
// came straight from a query, which is what makes citations honest.
// Each tool returns compact `facts` (fed to the composer), ready-to-render
// `blocks`, a `citation`, and optionally a deterministic `caveat`.
import { sql } from 'drizzle-orm';
import { db, schema } from '@/lib/db';
import { overviewForProject } from '@/lib/overview';
import { timelineBundleForProject, TIMELINE_RANGES, deviceOf, pathOfUrl } from '@/lib/timeline';
import { categorizeSource } from '@/lib/traffic-source';
import { segmentsForProject, FACET_DIMENSIONS, type Dimension } from '@/lib/user-segments';
import type { Citation, ResearcherBlock, ResearchPlan, SessionItem } from './types';

export const TOOL_TIMEOUT_MS = 20_000;

export interface ToolOutcome {
  facts: Record<string, unknown>;
  blocks: ResearcherBlock[];
  citation: Citation;
  caveat: string | null;
}

export interface ToolSpec {
  name: string;
  label: string;
  run: (projectId: string, args: Record<string, unknown>) => Promise<ToolOutcome>;
}

const fmtDur = (ms: number | null | undefined): string => {
  if (!ms) return '—';
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
};

const rangeOf = (args: Record<string, unknown>): string => {
  const r = typeof args.range === 'string' ? args.range : '7d';
  return TIMELINE_RANGES[r] ? r : '7d';
};

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function topEntries(rec: Record<string, number>, n = 6): [string, number][] {
  return Object.entries(rec).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, n);
}

function evidenceFrom(title: string, rec: Record<string, number>, n = 6): ResearcherBlock | null {
  const top = topEntries(rec, n);
  if (top.length === 0) return null;
  return { type: 'evidence', title, rows: top.map(([label, value]) => ({ label, value })) };
}

/** Small-sample honesty, computed — never left to the model to remember. */
function sampleCaveat(sessions: number, rangeLabel: string): string | null {
  if (sessions === 0) return `No sessions in ${rangeLabel} — figures below are zeros, not signal.`;
  if (sessions < 15) return `Only ${sessions} sessions in ${rangeLabel} — treat rates as directional, not statistical.`;
  return null;
}

// ---------------------------------------------------------------------------

const overviewSnapshot: ToolSpec = {
  name: 'overview_snapshot',
  label: 'Reading the overview',
  async run(projectId, args) {
    const range = rangeOf(args);
    const o = await overviewForProject(projectId, range);
    const t = o.data.totals;
    const rangeLabel = TIMELINE_RANGES[range].label;
    const blocks: ResearcherBlock[] = [];
    const src = evidenceFrom(`Sessions by source · ${rangeLabel}`, t.bySource as Record<string, number>);
    if (src) blocks.push(src);
    if (o.noteworthy.length > 0) {
      blocks.push({
        type: 'sessions',
        title: 'Noteworthy sessions',
        items: o.noteworthy.slice(0, 3).map((n) => ({
          id: n.id, startedAt: n.startedAt.toISOString(), durationMs: null, pages: 0,
          country: null, browser: null, note: n.summary || null, frustrated: n.frustrated, tags: [],
        })),
      });
    }
    return {
      facts: {
        range: rangeLabel,
        sessions: t.sessions, engaged: t.engaged, frustrated: t.frustrated,
        newVisitors: t.newVisitors, avgDuration: fmtDur(t.avgDurationMs),
        trends: o.data.trends.map((c) => `${c.label} ${c.value}`),
        needsAttention: o.attention.map((a) => a.text.replace('{strong}', a.strong)),
        topSegments: o.segments.slice(0, 3).map((s) => `${s.name} (${s.active} active of ${s.size})`),
        analystRead: o.analysis || null,
      },
      blocks,
      citation: { label: 'Overview', detail: `Overview snapshot · ${rangeLabel}`, href: `/projects/${projectId}/overview` },
      caveat: sampleCaveat(t.sessions, rangeLabel),
    };
  },
};

const getTimeline: ToolSpec = {
  name: 'get_timeline',
  label: 'Querying the timeline',
  async run(projectId, args) {
    const range = rangeOf(args);
    const { data } = await timelineBundleForProject(projectId, range);
    const t = data.totals;
    const rangeLabel = TIMELINE_RANGES[range].label;
    const focus = str(args.focus); // sources|devices|browsers|countries|referrers|entries|friction|tags
    const blocks: ResearcherBlock[] = [];
    const add = (b: ResearcherBlock | null) => { if (b && blocks.length < 3) blocks.push(b); };
    const catalog: Record<string, () => ResearcherBlock | null> = {
      sources: () => evidenceFrom(`By source · ${rangeLabel}`, t.bySource as Record<string, number>),
      devices: () => evidenceFrom(`By device · ${rangeLabel}`, t.byDevice),
      browsers: () => evidenceFrom(`By browser · ${rangeLabel}`, t.byBrowser),
      countries: () => evidenceFrom(`By country · ${rangeLabel}`, t.byCountry),
      referrers: () => evidenceFrom(`Top referrers · ${rangeLabel}`, t.byReferrerHost),
      entries: () => evidenceFrom(`Entry pages · ${rangeLabel}`, t.byEntryPath),
      friction: () => evidenceFrom(`Friction signals · ${rangeLabel}`, t.insightCounts),
    };
    if (focus && catalog[focus]) add(catalog[focus]());
    else { add(catalog.sources()); add(catalog.friction()); }
    return {
      facts: {
        range: rangeLabel,
        sessions: t.sessions, engaged: t.engaged, frustrated: t.frustrated,
        newVisitors: t.newVisitors, newSessions: t.newSessions, avgDuration: fmtDur(t.avgDurationMs),
        trendsVsPrevious: data.trends.map((c) => `${c.label} ${c.value} (${c.direction})`),
        frictionByKind: Object.fromEntries(topEntries(t.insightCounts, 8)),
        bySource: Object.fromEntries(topEntries(t.bySource as Record<string, number>, 8)),
        byDevice: Object.fromEntries(topEntries(t.byDevice, 4)),
        topCountries: Object.fromEntries(topEntries(t.byCountry, 5)),
        topEntryPages: Object.fromEntries(topEntries(t.byEntryPath, 5)),
        topReferrers: Object.fromEntries(topEntries(t.byReferrerHost, 5)),
      },
      blocks,
      citation: {
        label: 'Timeline',
        detail: `Timeline aggregates · ${rangeLabel}${focus ? ` · focus ${focus}` : ''}`,
        // Preconfigured view: the Timeline page opens on the measure the
        // question was about, not just the range.
        href: `/projects/${projectId}/timeline?range=${range}${
          focus === 'friction' ? '&measure=frustration'
          : focus === 'devices' ? '&measure=clicks'
          : ''}`,
      },
      caveat: sampleCaveat(t.sessions, rangeLabel),
    };
  },
};

interface SessionQueryRow extends Record<string, unknown> {
  id: string; started_at: string; duration_ms: number | null; page_count: number;
  country: string | null; browser: string | null; user_agent: string | null;
  page_url: string | null; referrer: string | null;
  intent_text: string | null; narrative: string | null; frustrated: boolean | null;
  tags: { name: string; color: string }[] | null;
}

const querySessions: ToolSpec = {
  name: 'query_sessions',
  label: 'Filtering sessions',
  async run(projectId, args) {
    const range = rangeOf(args);
    const rangeLabel = TIMELINE_RANGES[range].label;
    const limit = Math.min(Math.max(num(args.limit) ?? 8, 1), 10);
    const user = str(args.user);
    const tag = str(args.tag);
    const country = str(args.country);
    const browser = str(args.browser);
    const path = str(args.path);
    const device = str(args.device);
    const source = str(args.source);
    const minSeconds = num(args.minSeconds);
    const frustratedOnly = args.frustratedOnly === true;
    const newOnly = args.newOnly === true;
    const sort = str(args.sort) ?? 'recent'; // recent | longest | most_pages

    const conds = [sql`s.project_id = ${projectId}::uuid`, sql`s.event_count > 0`];
    if (range !== 'all') {
      conds.push(sql`s.started_at > now() - make_interval(secs => ${TIMELINE_RANGES[range].windowMs / 1000})`);
    }
    if (user) conds.push(sql`(s.user_id = ${user} OR s.anon_id = ${user} OR s.email ILIKE ${'%' + user + '%'})`);
    if (country) conds.push(sql`s.country ILIKE ${'%' + country + '%'}`);
    if (browser) conds.push(sql`s.browser ILIKE ${'%' + browser + '%'}`);
    if (path) conds.push(sql`s.page_url ILIKE ${'%' + path + '%'}`);
    if (minSeconds) conds.push(sql`s.duration_ms >= ${minSeconds * 1000}`);
    if (tag) {
      conds.push(sql`EXISTS (
        SELECT 1 FROM session_tags st JOIN tag_rules tr ON tr.id = st.tag_rule_id
        WHERE st.session_id = s.id AND tr.name ILIKE ${'%' + tag + '%'}
      )`);
    }
    if (frustratedOnly) {
      conds.push(sql`EXISTS (
        SELECT 1 FROM session_summaries fss
        WHERE fss.session_id = s.id AND jsonb_array_length(fss.insights) > 0
      )`);
    }
    if (newOnly) {
      // First-ever semantics — same rule as the timeline's "new visitors".
      conds.push(sql`NOT EXISTS (
        SELECT 1 FROM sessions prior
        WHERE prior.project_id = s.project_id
          AND coalesce(prior.user_id, prior.anon_id) = coalesce(s.user_id, s.anon_id)
          AND prior.started_at < s.started_at
      )`);
    }
    const whereSql = sql.join(conds, sql` AND `);
    const orderSql = sort === 'longest' ? sql`s.duration_ms DESC NULLS LAST`
      : sort === 'most_pages' ? sql`s.page_count DESC`
      : sql`s.started_at DESC`;
    // Device/source can't be pushed to SQL (they're JS classifications), so
    // over-fetch when they're present and filter here.
    const needsJsFilter = !!device || !!source;
    const fetchN = needsJsFilter ? 400 : limit;

    const res = await db.execute<SessionQueryRow>(sql`
      SELECT s.id, s.started_at, s.duration_ms, s.page_count, s.country, s.browser,
             s.user_agent, s.page_url, s.referrer,
             ss.intent_text, ss.narrative,
             (ss.id IS NOT NULL AND jsonb_array_length(ss.insights) > 0) AS frustrated,
             (SELECT json_agg(json_build_object('name', tr.name, 'color', tr.color))
              FROM session_tags st JOIN tag_rules tr ON tr.id = st.tag_rule_id
              WHERE st.session_id = s.id) AS tags
      FROM sessions s
      LEFT JOIN session_summaries ss ON ss.session_id = s.id AND ss.status = 'done'
      WHERE ${whereSql}
      ORDER BY ${orderSql}
      LIMIT ${fetchN}
    `);
    let rows: SessionQueryRow[] = Array.isArray(res) ? res : (res as unknown as { rows: SessionQueryRow[] }).rows ?? [];
    if (device) rows = rows.filter((r) => deviceOf(r.user_agent) === device.toLowerCase());
    if (source) rows = rows.filter((r) => categorizeSource(r.referrer, r.page_url) === source.toLowerCase());
    const truncated = needsJsFilter && rows.length > limit;
    const matched = rows.length;
    rows = rows.slice(0, limit);

    // Exact total when all filters ran in SQL (cheap second count).
    let total = matched;
    if (!needsJsFilter) {
      const cRes = await db.execute<{ value: string }>(sql`SELECT count(*) AS value FROM sessions s WHERE ${whereSql}`);
      const cRows = Array.isArray(cRes) ? cRes : (cRes as unknown as { rows: { value: string }[] }).rows ?? [];
      total = Number(cRows[0]?.value ?? matched);
    }

    const items: SessionItem[] = rows.map((r) => ({
      id: r.id,
      startedAt: new Date(r.started_at).toISOString(),
      durationMs: r.duration_ms,
      pages: r.page_count,
      country: r.country,
      browser: r.browser,
      note: (r.intent_text || r.narrative || '').trim().slice(0, 160) || null,
      frustrated: !!r.frustrated,
      tags: r.tags ?? [],
    }));

    const filterWords = [
      range !== 'all' ? rangeLabel : 'all time',
      user && `visitor "${user}"`, tag && `tag "${tag}"`, device, source, country, browser,
      path && `URL contains "${path}"`, minSeconds && `≥${minSeconds}s`,
      frustratedOnly && 'with friction', newOnly && 'first-ever visits',
    ].filter(Boolean).join(' · ');

    const params = new URLSearchParams();
    if (range !== '24h') params.set('range', range);
    if (user) params.set('user', user);
    const href = `/projects/${projectId}/sessions${params.size ? `?${params}` : ''}`;

    return {
      facts: {
        matched: needsJsFilter ? `${matched}${truncated ? '+' : ''} (of newest 400 scanned)` : total,
        filters: filterWords,
        shown: items.map((i) => ({
          when: i.startedAt, duration: fmtDur(i.durationMs), pages: i.pages,
          country: i.country, browser: i.browser, frustrated: i.frustrated,
          note: i.note, tags: i.tags.map((t) => t.name),
        })),
      },
      blocks: items.length > 0 ? [{ type: 'sessions', title: `Sessions to watch · ${filterWords}`, items }] : [],
      citation: { label: 'Sessions', detail: `Sessions where ${filterWords}`, href },
      caveat: items.length === 0
        ? `No sessions matched (${filterWords}) — the filters may be too narrow.`
        : needsJsFilter && truncated ? 'Device/source filters scan the newest 400 sessions — older matches are not counted.' : null,
    };
  },
};

interface VisitorRow extends Record<string, unknown> {
  key: string; email: string | null; display_name: string | null;
  session_count: string; total_ms: string | null; last_seen: string; country: string | null;
  profile_text: string | null;
}

const queryVisitors: ToolSpec = {
  name: 'query_visitors',
  label: 'Grouping visitors',
  async run(projectId, args) {
    const range = rangeOf(args);
    const rangeLabel = TIMELINE_RANGES[range].label;
    const limit = Math.min(Math.max(num(args.limit) ?? 8, 1), 10);
    const sort = str(args.sort) ?? 'sessions'; // sessions | time | recent
    const timeCond = range !== 'all'
      ? sql`AND s.started_at > now() - make_interval(secs => ${TIMELINE_RANGES[range].windowMs / 1000})`
      : sql``;
    const orderSql = sort === 'time' ? sql`total_ms DESC NULLS LAST`
      : sort === 'recent' ? sql`last_seen DESC`
      : sql`session_count DESC`;
    const res = await db.execute<VisitorRow>(sql`
      SELECT coalesce(s.user_id, s.anon_id) AS key,
             max(s.email) AS email, max(s.display_name) AS display_name,
             count(*) AS session_count, sum(s.duration_ms) AS total_ms,
             max(s.last_activity_at) AS last_seen, max(s.country) AS country,
             max(up.profile_text) AS profile_text
      FROM sessions s
      LEFT JOIN user_profiles up
        ON up.project_id = s.project_id AND up.visitor_key = coalesce(s.user_id, s.anon_id) AND up.status = 'done'
      WHERE s.project_id = ${projectId}::uuid AND s.event_count > 0 ${timeCond}
      GROUP BY coalesce(s.user_id, s.anon_id)
      ORDER BY ${orderSql}
      LIMIT ${limit}
    `);
    const rows: VisitorRow[] = Array.isArray(res) ? res : (res as unknown as { rows: VisitorRow[] }).rows ?? [];
    const table: ResearcherBlock = {
      type: 'table',
      title: `Top visitors · ${rangeLabel} · by ${sort}`,
      columns: ['Visitor', 'Sessions', 'Total time', 'Last seen'],
      rows: rows.map((r) => [
        r.display_name || r.email || `${r.key.slice(0, 10)}…`,
        String(r.session_count),
        fmtDur(r.total_ms ? Number(r.total_ms) : null),
        new Date(r.last_seen).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }),
      ]),
    };
    return {
      facts: {
        range: rangeLabel,
        visitors: rows.map((r) => ({
          who: r.display_name || r.email || r.key.slice(0, 12),
          sessions: Number(r.session_count),
          totalTime: fmtDur(r.total_ms ? Number(r.total_ms) : null),
          country: r.country,
          profile: r.profile_text ? r.profile_text.slice(0, 200) : null,
        })),
      },
      blocks: rows.length > 0 ? [table] : [],
      citation: { label: 'Visitors', detail: `Visitors grouped by ${sort} · ${rangeLabel}`, href: `/projects/${projectId}/users?range=${range}` },
      caveat: rows.length === 0 ? `No visitors in ${rangeLabel}.` : null,
    };
  },
};

const getClusters: ToolSpec = {
  name: 'get_clusters',
  label: 'Reading segments',
  async run(projectId, args) {
    const dimArg = str(args.dimension)?.toLowerCase();
    const dimension: Dimension = (FACET_DIMENSIONS as readonly string[]).includes(dimArg ?? '')
      ? dimArg as Dimension : 'overall';
    const segmentArg = str(args.segment);
    const segments = await segmentsForProject(projectId, dimension);
    // A named segment steers the deep link: the cluster map opens with it
    // spotlighted. Loose match so "frantic integrators" finds the segment.
    const spotlit = segmentArg
      ? segments.find((s) => s.name.toLowerCase().includes(segmentArg.toLowerCase())
          || segmentArg.toLowerCase().includes(s.name.toLowerCase()))
      : undefined;
    const [dimAnalysis] = await db.select().from(schema.dimensionAnalyses)
      .where(sql`${schema.dimensionAnalyses.projectId} = ${projectId} AND ${schema.dimensionAnalyses.dimension} = ${dimension}`)
      .limit(1);
    const evidence = evidenceFrom(
      `Segments · ${dimension}`,
      Object.fromEntries(segments.map((s) => [s.name, s.size])),
      8,
    );
    const params = new URLSearchParams();
    if (dimension !== 'overall') params.set('dimension', dimension);
    if (spotlit) params.set('segment', spotlit.name);
    return {
      facts: {
        dimension,
        ...(spotlit ? { focusedSegment: { name: spotlit.name, size: spotlit.size, description: spotlit.description, analysis: spotlit.analysis ? spotlit.analysis.slice(0, 400) : null } } : {}),
        segments: segments.map((s) => ({ name: s.name, size: s.size, description: s.description, analysis: s.analysis ? s.analysis.slice(0, 300) : null })),
        dimensionAnalysis: dimAnalysis?.analysis?.slice(0, 400) || null,
      },
      blocks: evidence ? [evidence] : [],
      citation: {
        label: 'Clusters',
        detail: `Behavioral segments · ${dimension} dimension${spotlit ? ` · “${spotlit.name}” spotlighted` : ''}`,
        href: `/projects/${projectId}/clusters${params.size ? `?${params}` : ''}`,
      },
      caveat: segments.length === 0
        ? 'No segments yet — clustering needs at least 4 finished visitor profiles.'
        : null,
    };
  },
};

interface DigestRow extends Record<string, unknown> {
  id: string; started_at: string; duration_ms: number | null; page_count: number;
  country: string | null; browser: string | null; page_url: string | null; referrer: string | null;
  narrative: string | null; intent_text: string | null; insights: unknown; clicks: number | null;
}

const sessionDigest: ToolSpec = {
  name: 'session_digest',
  label: 'Reading one session',
  async run(projectId, args) {
    const sessionId = str(args.sessionId);
    if (!sessionId || !/^[0-9a-f-]{36}$/i.test(sessionId)) {
      return {
        facts: { error: 'a session id is required' },
        blocks: [],
        citation: { label: 'Session', detail: 'Session digest (no id given)', href: null },
        caveat: 'No session id was given — ask for sessions first, then dig into one.',
      };
    }
    const res = await db.execute<DigestRow>(sql`
      SELECT s.id, s.started_at, s.duration_ms, s.page_count, s.country, s.browser,
             s.page_url, s.referrer, ss.narrative, ss.intent_text, ss.insights, ss.clicks
      FROM sessions s
      LEFT JOIN session_summaries ss ON ss.session_id = s.id
      WHERE s.id = ${sessionId}::uuid AND s.project_id = ${projectId}::uuid
      LIMIT 1
    `);
    const rows: DigestRow[] = Array.isArray(res) ? res : (res as unknown as { rows: DigestRow[] }).rows ?? [];
    const r = rows[0];
    if (!r) {
      return {
        facts: { error: 'session not found in this project' },
        blocks: [],
        citation: { label: 'Session', detail: `Session ${sessionId}`, href: null },
        caveat: 'That session id does not exist in this project.',
      };
    }
    const insights = Array.isArray(r.insights) ? r.insights as { kind: string; at: number }[] : [];
    return {
      facts: {
        session: {
          id: r.id, started: new Date(r.started_at).toISOString(), duration: fmtDur(r.duration_ms),
          pages: r.page_count, clicks: r.clicks ?? undefined, country: r.country, browser: r.browser,
          entry: pathOfUrl(r.page_url), referrer: r.referrer || 'direct',
          aiIntent: r.intent_text || null,
          narrative: (r.narrative || '').slice(0, 800) || null,
          frictionSignals: insights.map((i) => i.kind),
        },
      },
      blocks: [{
        type: 'sessions', title: 'This session',
        items: [{
          id: r.id, startedAt: new Date(r.started_at).toISOString(), durationMs: r.duration_ms,
          pages: r.page_count, country: r.country, browser: r.browser,
          note: (r.intent_text || r.narrative || '').trim().slice(0, 160) || null,
          frustrated: insights.length > 0, tags: [],
        }],
      }],
      citation: { label: 'Session', detail: `Full digest of session ${r.id.slice(0, 8)}…`, href: `/sessions/${r.id}` },
      caveat: r.narrative ? null : 'This session has no AI summary yet — figures come from the raw row.',
    };
  },
};

const previewTagRule: ToolSpec = {
  name: 'preview_tag_rule',
  label: 'Previewing the tag',
  async run(projectId, args) {
    const kind = args.kind === 'session_count_gte' ? 'session_count_gte' : 'url_contains';
    const value = str(args.value) ?? '';
    if (!value) {
      return {
        facts: { error: 'tag rule needs a value' }, blocks: [],
        citation: { label: 'Tags', detail: 'Tag rule preview', href: `/projects/${projectId}/tags` },
        caveat: 'The tag draft needs a value (a URL fragment or a session-count threshold).',
      };
    }
    let matchCount = 0;
    let visitorCount = 0;
    let approx = false;
    if (kind === 'session_count_gte') {
      const threshold = parseInt(value, 10) || 1;
      const res = await db.execute<{ n: string; v: string }>(sql`
        SELECT count(*) AS n, count(DISTINCT anon_id) AS v FROM (
          SELECT id, anon_id, row_number() OVER (PARTITION BY anon_id ORDER BY started_at) AS rn
          FROM sessions WHERE project_id = ${projectId}::uuid
        ) s WHERE s.rn >= ${threshold}
      `);
      const rows = Array.isArray(res) ? res : (res as unknown as { rows: { n: string; v: string }[] }).rows ?? [];
      matchCount = Number(rows[0]?.n ?? 0);
      visitorCount = Number(rows[0]?.v ?? 0);
    } else {
      // Entry-URL approximation: the real rule also matches every visited
      // URL inside the replay, which is too heavy to preview live.
      approx = true;
      const res = await db.execute<{ n: string; v: string }>(sql`
        SELECT count(*) AS n, count(DISTINCT coalesce(user_id, anon_id)) AS v FROM sessions
        WHERE project_id = ${projectId}::uuid AND page_url ILIKE ${'%' + value + '%'}
      `);
      const rows = Array.isArray(res) ? res : (res as unknown as { rows: { n: string; v: string }[] }).rows ?? [];
      matchCount = Number(rows[0]?.n ?? 0);
      visitorCount = Number(rows[0]?.v ?? 0);
    }
    return {
      facts: { tagPreview: { kind, value, matchCount, visitorCount, approx } },
      blocks: [],
      citation: { label: 'Tags', detail: `Tag rule preview: ${kind} "${value}"`, href: `/projects/${projectId}/tags` },
      caveat: approx ? 'Preview counts entry URLs only; applying the rule also scans in-session navigation, so the final count can be higher.' : null,
    };
  },
};

export const TOOLS: Record<string, ToolSpec> = Object.fromEntries(
  [overviewSnapshot, getTimeline, querySessions, queryVisitors, getClusters, sessionDigest, previewTagRule]
    .map((t) => [t.name, t]),
);

export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${what} timed out after ${ms / 1000}s`)), ms)),
  ]);
}

/** The never-dead-end floor: when a plan is empty or entirely failed,
 * this is what runs instead of an apology. */
export function floorStep(): ResearchPlan['steps'][number] {
  return { tool: 'overview_snapshot', args: { range: '7d' } };
}
