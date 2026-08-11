import { SignJWT, jwtVerify } from 'jose';
import { cookies } from 'next/headers';
import { timingSafeEqual } from 'node:crypto';

const ALG = 'HS256';
const SESSION_COOKIE = 'mega_session';
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

// Admins come from ADMINS_CREDS, a JSON array of { email, password }.
// Falls back to the legacy single-admin ADMIN_EMAIL/ADMIN_PASSWORD vars
// when ADMINS_CREDS is absent or malformed, so existing deploys keep working.
function adminCreds(): AdminCred[] {
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
  for (const cred of adminCreds()) {
    if (constEq(candidate, cred.email) && constEq(password, cred.password)) ok = true;
  }
  return ok;
}

// `email` identifies which admin is logged in — it's the per-admin key for
// viewed-state tracking. Required: tokens minted before multi-admin support
// lack it and must fail verification so those admins are forced to re-login.
export interface SessionJwt { role: 'admin'; orgId: string; email: string; }

export async function signSessionJwt(p: { orgId: string; email: string }): Promise<string> {
  return new SignJWT({ role: 'admin', orgId: p.orgId, email: p.email })
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
    payload.email === ''
  ) {
    throw new Error('invalid session payload');
  }
  return { role: 'admin', orgId: payload.orgId, email: payload.email };
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
