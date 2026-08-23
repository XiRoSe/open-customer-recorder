import { db, schema } from '@/lib/db';
import { count, eq, and, lt } from 'drizzle-orm';
import { nanoid } from 'nanoid';

/**
 * Ensure the singleton org + default project exist on first boot, AND that
 * the project name matches ORG_NAME (renames the project if ORG_NAME changes).
 */
export async function ensureSingletonOrg() {
  const orgName = process.env.ORG_NAME || 'My Company';
  const projectName = orgName; // single project per org for MVP, named the same

  const [{ value: orgCount }] = await db.select({ value: count() }).from(schema.organizations);

  if (orgCount === 0) {
    const [org] = await db.insert(schema.organizations).values({ name: orgName }).returning();
    await db.insert(schema.projects).values({
      orgId: org.id,
      name: projectName,
      projectKey: `umsk_${nanoid(20)}`,
    });
    console.log(`[bootstrap] created singleton org ${orgName} (${org.id}) with ${projectName} project`);
    return;
  }

  // Existing org — make sure the (only) project is named correctly.
  const projects = await db.select().from(schema.projects).limit(1);
  if (projects.length === 0) {
    const [org] = await db.select().from(schema.organizations).limit(1);
    await db.insert(schema.projects).values({
      orgId: org.id,
      name: projectName,
      projectKey: `umsk_${nanoid(20)}`,
    });
    console.log(`[bootstrap] created ${projectName} project on existing org ${org.id}`);
    return;
  }
  const p = projects[0];
  if (p.name !== projectName) {
    await db.update(schema.projects).set({ name: projectName }).where(eq(schema.projects.id, p.id));
    console.log(`[bootstrap] renamed project ${p.id} to ${projectName}`);
  }
}

/**
 * Wipe sessions that captured no events and are older than 5 minutes.
 *
 * With the lazy-/start recorder these rows shouldn't be created at all,
 * but legacy rows from older builds linger and a /start race during
 * unload can still produce the occasional orphan. 5 min is well past the
 * 30s flush+ping window — any live session has had ample time to land
 * its first events, so a 0-event row is dead.
 */
export async function cleanupZeroEventSessions() {
  const cutoff = new Date(Date.now() - 5 * 60 * 1000);
  const stale = await db
    .select({ id: schema.sessions.id })
    .from(schema.sessions)
    .where(and(eq(schema.sessions.eventCount, 0), lt(schema.sessions.createdAt, cutoff)));
  if (stale.length === 0) return;
  for (const s of stale) {
    await db.delete(schema.sessions).where(eq(schema.sessions.id, s.id));
  }
  console.log(`[bootstrap] cleaned up ${stale.length} zero-event session rows`);
}
