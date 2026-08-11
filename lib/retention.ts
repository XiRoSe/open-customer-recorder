import { db, schema } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { deleteSessionBlob } from '@/lib/blob';

export async function runRetentionOnce() {
  // For each project, delete sessions older than retentionDays
  const projects = await db.select().from(schema.projects);
  for (const p of projects) {
    const stale = await db.execute<{ id: string }>(sql`
      DELETE FROM ${schema.sessions}
      WHERE project_id = ${p.id}
        AND created_at < now() - (${p.retentionDays} || ' days')::interval
      RETURNING id
    `);
    // postgres-js returns a RowList (array-like); some adapters wrap in { rows }
    const rows: { id: string }[] = (
      Array.isArray(stale) ? stale : (stale as unknown as { rows: { id: string }[] }).rows ?? []
    );
    for (const row of rows) {
      await deleteSessionBlob(row.id).catch(() => {});
    }
  }
}
