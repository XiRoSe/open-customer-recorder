import { NextRequest, NextResponse } from 'next/server';
import { db, schema } from '@/lib/db';
import { and, eq } from 'drizzle-orm';
import { readSessionCookie } from '@/lib/auth';
import { gunzipSync } from 'node:zlib';

export async function GET(_req: NextRequest | Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await readSessionCookie();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { id } = await ctx.params;
  // Confirm session belongs to caller's org and pull blob_data
  const rows = await db
    .select({ id: schema.sessions.id, blobData: schema.sessions.blobData })
    .from(schema.sessions)
    .innerJoin(schema.projects, eq(schema.projects.id, schema.sessions.projectId))
    .where(and(eq(schema.sessions.id, id), eq(schema.projects.orgId, session.orgId)))
    .limit(1);
  if (rows.length === 0) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const buf = rows[0].blobData;
  if (!buf || buf.length === 0) {
    return NextResponse.json({ error: 'blob empty' }, { status: 404 });
  }

  // CRITICAL: blob_data is multiple gzip members concatenated. Node's
  // gunzipSync handles that correctly, but browsers' Content-Encoding:gzip
  // decoder reads only the FIRST member then stops — that's why the player
  // was seeing only ~5s of events when the blob had 51s. Decompress
  // server-side and serve plain NDJSON.
  let plain: Buffer;
  try {
    plain = gunzipSync(buf);
  } catch {
    return NextResponse.json({ error: 'failed to decompress blob' }, { status: 500 });
  }

  return new Response(new Uint8Array(plain), {
    headers: {
      'content-type': 'application/x-ndjson',
      // No caching — sessions can keep growing as ingest continues.
      'cache-control': 'no-store',
    },
  });
}
