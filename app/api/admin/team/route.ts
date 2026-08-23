import { NextRequest, NextResponse } from 'next/server';
import { db, schema } from '@/lib/db';
import { asc, eq } from 'drizzle-orm';
import { readSessionCookie, nameFromEmail } from '@/lib/auth';
import bcrypt from 'bcryptjs';

// The token says who's asking; the DB says what they may do — a demoted
// or deactivated owner's still-valid token must not keep its powers.
async function requireOwner(): Promise<{ orgId: string; userId: string } | null> {
  const session = await readSessionCookie();
  if (!session) return null;
  const [me] = await db.select().from(schema.adminUsers)
    .where(eq(schema.adminUsers.id, session.userId)).limit(1);
  if (!me || !me.active || me.role !== 'owner') return null;
  return { orgId: session.orgId, userId: session.userId };
}

export async function GET() {
  const session = await readSessionCookie();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const rows = await db.select({
    id: schema.adminUsers.id,
    email: schema.adminUsers.email,
    name: schema.adminUsers.name,
    role: schema.adminUsers.role,
    active: schema.adminUsers.active,
    lastLoginAt: schema.adminUsers.lastLoginAt,
    createdAt: schema.adminUsers.createdAt,
  }).from(schema.adminUsers).orderBy(asc(schema.adminUsers.createdAt));
  return NextResponse.json({ users: rows, me: session.userId });
}

export async function POST(req: NextRequest) {
  const owner = await requireOwner();
  if (!owner) return NextResponse.json({ error: 'owner only' }, { status: 403 });

  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: 'invalid body' }, { status: 400 });
  const email = typeof body.email === 'string' ? body.email.toLowerCase().trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : nameFromEmail(email);
  const role = body.role === 'owner' ? 'owner' : 'member';
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return NextResponse.json({ error: 'valid email required' }, { status: 400 });
  }
  if (password.length < 8) {
    return NextResponse.json({ error: 'password must be at least 8 characters' }, { status: 400 });
  }

  const [created] = await db.insert(schema.adminUsers).values({
    orgId: owner.orgId,
    email,
    name,
    passwordHash: await bcrypt.hash(password, 10),
    role,
  }).onConflictDoNothing().returning();
  if (!created) return NextResponse.json({ error: 'an account with that email already exists' }, { status: 409 });

  return NextResponse.json({
    user: { id: created.id, email: created.email, name: created.name, role: created.role, active: created.active },
  }, { status: 201 });
}
