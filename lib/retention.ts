import { db, schema } from '@/lib/db';
import { sql } from 'drizzle-orm';

export async function runRetentionOnce() {
  // For each project, delete sessions older than retentionDays. Blobs
  // live inline (bytea) and summaries/tags/views cascade — one DELETE
  // is the whole job.
  const projects = await db.select().from(schema.projects);
  for (const p of projects) {
    await db.execute(sql`
      DELETE FROM ${schema.sessions}
      WHERE project_id = ${p.id}
        AND created_at < now() - (${p.retentionDays} || ' days')::interval
    `);
  }
}
