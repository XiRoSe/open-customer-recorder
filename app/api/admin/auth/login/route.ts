import { NextRequest, NextResponse } from 'next/server';
import { db, schema } from '@/lib/db';
import { authenticateAdmin, signSessionJwt, setSessionCookie } from '@/lib/auth';

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: 'invalid body' }, { status: 400 });
  const email = typeof body.email === 'string' ? body.email : null;
  const password = typeof body.password === 'string' ? body.password : null;
  if (!email || !password) return NextResponse.json({ error: 'email + password required' }, { status: 400 });

  const admin = await authenticateAdmin(email, password);
  if (!admin) {
    return NextResponse.json({ error: 'invalid credentials' }, { status: 401 });
  }

  // Look up the singleton org (auto-created at boot via instrumentation.ts)
  const [org] = await db.select().from(schema.organizations).limit(1);
  if (!org) {
    return NextResponse.json({ error: 'org not initialized; restart the app' }, { status: 503 });
  }

  const token = await signSessionJwt({
    orgId: org.id,
    email: admin.email,
    userId: admin.userId,
    name: admin.name,
    userRole: admin.userRole,
  });
  await setSessionCookie(token);
  return NextResponse.json({ ok: true });
}
