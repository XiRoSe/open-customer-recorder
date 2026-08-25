import { db, schema } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';

export async function resetDb() {
  // delete in reverse dependency order
  await db.delete(schema.sessionViews);
  await db.delete(schema.sessions);
  await db.delete(schema.projects);
  await db.delete(schema.organizations);
  await db.delete(schema.leads);
}

export async function createOrgWithProject() {
  const [org] = await db.insert(schema.organizations).values({ name: 'Test Org' }).returning();
  const [project] = await db.insert(schema.projects).values({
    orgId: org.id,
    name: 'Test Project',
    projectKey: `umsk_${nanoid(20)}`,
  }).returning();
  return { org, project };
}

export async function ping() {
  await db.execute(sql`select 1`);
}
