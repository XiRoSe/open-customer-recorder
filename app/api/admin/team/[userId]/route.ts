import { NextRequest, NextResponse } from 'next/server';
import { db, schema } from '@/lib/db';
import { and, count, eq, ne } from 'drizzle-orm';
import { readSessionCookie } from '@/lib/auth';
import bcrypt from 'bcryptjs';

async function requireOwner(): Promise<{ userId: string } | null> {
  const session = await readSessionCookie();
  if (!session) return null;
  const [me] = await db.select().from(schema.adminUsers)
    .where(eq(schema.adminUsers.id, session.userId)).limit(1);
  if (!me || !me.active || me.role !== 'owner') return null;
  return { userId: session.userId };
}

/** Would this change leave the org with zero active owners? */
async function lastActiveOwner(targetId: string): Promise<boolean> {
  const [{ value: others }] = await db.select({ value: count() }).from(schema.adminUsers)
    .where(and(
      ne(schema.adminUsers.id, targetId),
      eq(schema.adminUsers.role, 'owner'),
      eq(schema.adminUsers.active, true),
    ));
  return others === 0;
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ userId: string }> }) {
  const owner = await requireOwner();
  if (!owner) return NextResponse.json({ error: 'owner only' }, { status: 403 });
  const { userId } = await ctx.params;

  const [target] = await db.select().from(schema.adminUsers)
    .where(eq(schema.adminUsers.id, userId)).limit(1);
  if (!target) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: 'invalid body' }, { status: 400 });

  const patch: Partial<{ role: string; active: boolean; passwordHash: string; name: string }> = {};

  if (body.role === 'owner' || body.role === 'member') {
    if (body.role === 'member' && target.role === 'owner' && await lastActiveOwner(userId)) {
      return NextResponse.json({ error: 'cannot demote the last owner' }, { status: 400 });
    }
    patch.role = body.role;
  }
  if (typeof body.active === 'boolean') {
    if (!body.active && target.role === 'owner' && target.active && await lastActiveOwner(userId)) {
      return NextResponse.json({ error: 'cannot deactivate the last owner' }, { status: 400 });
    }
    patch.active = body.active;
  }
  if (typeof body.password === 'string' && body.password) {
    if (body.password.length < 8) {
      return NextResponse.json({ error: 'password must be at least 8 characters' }, { status: 400 });
    }
    patch.passwordHash = await bcrypt.hash(body.password, 10);
  }
  if (typeof body.name === 'string' && body.name.trim()) {
    patch.name = body.name.trim();
  }
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'nothing to update' }, { status: 400 });
  }

  const [updated] = await db.update(schema.adminUsers).set(patch)
    .where(eq(schema.adminUsers.id, userId)).returning();
  return NextResponse.json({
    user: { id: updated.id, email: updated.email, name: updated.name, role: updated.role, active: updated.active },
  });
}
