import { redirect } from 'next/navigation';
import { db, schema } from '@/lib/db';
import { and, eq } from 'drizzle-orm';
import { readSessionCookie } from '@/lib/auth';
import { markSessionViewed } from '@/lib/session-views';
import { tagsForSessions } from '@/lib/session-tags';
import { ReplayPlayer } from '@/components/replay-player';
import { DeleteSessionButton } from '@/components/delete-session-button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import type { TagColor } from '@/lib/tag-colors';

export default async function SessionReplayPage(props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const session = await readSessionCookie();
  if (!session) redirect('/login');
  const rows = await db.select({ s: schema.sessions, p: schema.projects }).from(schema.sessions)
    .innerJoin(schema.projects, eq(schema.projects.id, schema.sessions.projectId))
    .where(and(eq(schema.sessions.id, id), eq(schema.projects.orgId, session.orgId)))
    .limit(1);
  if (rows.length === 0) redirect('/projects');
  const { s, p } = rows[0];

  // Side effect: mark this session viewed by the current admin. Per-admin,
  // so opening a session only affects this admin's unviewed list. Idempotent,
  // so reopening is a no-op.
  await markSessionViewed(id, session.email).catch(() => {});
  const tags = (await tagsForSessions([id])).get(id) ?? [];

  return (
    <main className="max-w-6xl mx-auto p-6 space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold">
            {s.email || s.userId || `Anonymous ${s.anonId.slice(0,8)}`}
          </h1>
          <p className="text-sm text-muted-foreground">
            {p.name} · {new Date(s.startedAt).toLocaleString('en-GB')} · {s.country || '—'} · {s.browser || '—'} · {s.pageCount} pages · {s.eventCount} events
          </p>
          {tags.length > 0 && (
            <div className="flex flex-wrap gap-1 pt-1">
              {tags.map((t) => <Badge key={t.id} variant={t.color as TagColor}>{t.name}</Badge>)}
            </div>
          )}
        </div>
        <DeleteSessionButton sessionId={id} redirectTo={`/projects/${p.id}/sessions`} />
      </div>
      <Card className="p-4">
        <ReplayPlayer sessionId={id} eventCount={s.eventCount} />
      </Card>
    </main>
  );
}
