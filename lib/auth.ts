import { SignJWT, jwtVerify } from 'jose';
import { cookies } from 'next/headers';
import { timingSafeEqual } from 'node:crypto';
import bcrypt from 'bcryptjs';

const ALG = 'HS256';
// Renamed from 'mega_session' in the PocketScience rebrand — no
// migration needed, this is a server-set httpOnly cookie (not embedded
// in customer markup), so the one-time side effect is just that every
// logged-in admin needs to log back in once after deploy.
const SESSION_COOKIE = 'ps_session';
const SESSION_TTL_DAYS = 7;

function jwtSecret() {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error('JWT_SECRET is required');
  return new TextEncoder().encode(s);
}

function constEq(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

interface AdminCred { email: string; password: string; }

// Legacy env credentials: ADMINS_CREDS, a JSON array of { email, password },
// falling back to single-admin ADMIN_EMAIL/ADMIN_PASSWORD. Since the
// admin_users table these only matter twice: boot seeding (lib/bootstrap)
// and the one-release login fallback below.
export function envAdminCreds(): AdminCred[] {
  const raw = process.env.ADMINS_CREDS;
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed
          .filter((c): c is AdminCred =>
            !!c && typeof c.email === 'string' && typeof c.password === 'string')
          .map((c) => ({ email: c.email.toLowerCase().trim(), password: c.password }));
      }
    } catch {
      // fall through to legacy single-admin vars
    }
  }
  const email = (process.env.ADMIN_EMAIL || '').toLowerCase().trim();
  const password = process.env.ADMIN_PASSWORD || '';
  return email && password ? [{ email, password }] : [];
}

export function checkAdminCredentials(email: string, password: string): boolean {
  const candidate = email.toLowerCase().trim();
  // Check every entry (no early return) to avoid leaking which email matched.
  let ok = false;
  for (const cred of envAdminCreds()) {
    if (constEq(candidate, cred.email) && constEq(password, cred.password)) ok = true;
  }
  return ok;
}

export interface AuthenticatedAdmin {
  userId: string;
  email: string;
  name: string;
  userRole: 'owner' | 'member';
}

/** Display name fallback when all we have is an email. */
export function nameFromEmail(email: string): string {
  const local = email.split('@')[0] || email;
  return local.charAt(0).toUpperCase() + local.slice(1);
}

/**
 * DB-backed login. The admin_users table is the source of truth; the env
 * credentials stay honored for one release as a fallback (and lazily
 * create the missing row so the next login is pure-DB). Returns null on
 * any failure — callers never learn which check failed.
 */
export async function authenticateAdmin(email: string, password: string): Promise<AuthenticatedAdmin | null> {
  const candidate = email.toLowerCase().trim();
  const { db, schema } = await import('@/lib/db');
  const { eq, count } = await import('drizzle-orm');

  const [row] = await db.select().from(schema.adminUsers)
    .where(eq(schema.adminUsers.email, candidate)).limit(1);

  if (row) {
    if (!row.active) return null;
    const ok = await bcrypt.compare(password, row.passwordHash);
    if (!ok) return null;
    await db.update(schema.adminUsers)
      .set({ lastLoginAt: new Date() })
      .where(eq(schema.adminUsers.id, row.id));
    return { userId: row.id, email: row.email, name: row.name, userRole: row.role === 'owner' ? 'owner' : 'member' };
  }

  // Fallback: env credentials for an email with no DB row yet (e.g. the
  // seed hasn't run, or ADMINS_CREDS gained an entry post-boot). On
  // success, materialize the row so the DB takes over from here on.
  if (!checkAdminCredentials(candidate, password)) return null;
  const [org] = await db.select().from(schema.organizations).limit(1);
  if (!org) return null;
  const [{ value: existing }] = await db.select({ value: count() }).from(schema.adminUsers);
  const [created] = await db.insert(schema.adminUsers).values({
    orgId: org.id,
    email: candidate,
    name: nameFromEmail(candidate),
    passwordHash: await bcrypt.hash(password, 10),
    // First account ever becomes the owner; later env stragglers join as members.
    role: existing === 0 ? 'owner' : 'member',
    lastLoginAt: new Date(),
  }).onConflictDoNothing().returning();
  if (!created) return null;
  return { userId: created.id, email: created.email, name: created.name, userRole: created.role === 'owner' ? 'owner' : 'member' };
}

// The session token identifies the admin three ways: `email` keys
// viewed-state tracking (predates the users table), `userId` keys
// Researcher threads, `userRole` gates Team mutations. All are required:
// tokens minted before users management lack them and must fail
// verification so those admins re-login and get the full payload.
export interface SessionJwt {
  role: 'admin';
  orgId: string;
  email: string;
  userId: string;
  name: string;
  userRole: 'owner' | 'member';
}

export async function signSessionJwt(p: { orgId: string; email: string; userId: string; name: string; userRole: 'owner' | 'member' }): Promise<string> {
  return new SignJWT({ role: 'admin', orgId: p.orgId, email: p.email, userId: p.userId, name: p.name, userRole: p.userRole })
    .setProtectedHeader({ alg: ALG })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_DAYS}d`)
    .sign(jwtSecret());
}

export async function verifySessionJwt(token: string): Promise<SessionJwt> {
  const { payload } = await jwtVerify(token, jwtSecret());
  if (
    payload.role !== 'admin' ||
    typeof payload.orgId !== 'string' ||
    typeof payload.email !== 'string' ||
    payload.email === '' ||
    typeof payload.userId !== 'string' ||
    payload.userId === '' ||
    typeof payload.name !== 'string' ||
    (payload.userRole !== 'owner' && payload.userRole !== 'member')
  ) {
    throw new Error('invalid session payload');
  }
  return {
    role: 'admin',
    orgId: payload.orgId,
    email: payload.email,
    userId: payload.userId,
    name: payload.name,
    userRole: payload.userRole,
  };
}

export async function setSessionCookie(token: string) {
  const c = await cookies();
  c.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: SESSION_TTL_DAYS * 24 * 60 * 60,
    path: '/',
  });
}

export async function clearSessionCookie() {
  const c = await cookies();
  c.delete(SESSION_COOKIE);
}

export async function readSessionCookie(): Promise<SessionJwt | null> {
  const c = await cookies();
  const t = c.get(SESSION_COOKIE)?.value;
  if (!t) return null;
  try { return await verifySessionJwt(t); } catch { return null; }
}
