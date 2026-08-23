import { describe, it, expect, beforeEach } from 'vitest';
import { SignJWT } from 'jose';
import { checkAdminCredentials, signSessionJwt, verifySessionJwt } from './auth';

beforeEach(() => {
  process.env.JWT_SECRET = 'jwt-secret-must-be-at-least-32-bytes-aaaa';
  process.env.ADMIN_EMAIL = 'admin@example.com';
  process.env.ADMIN_PASSWORD = 'hunter2';
  delete process.env.ADMINS_CREDS;
});

describe('auth', () => {
  it('accepts correct admin credentials', () => {
    expect(checkAdminCredentials('admin@example.com', 'hunter2')).toBe(true);
    expect(checkAdminCredentials('admin@example.com', 'wrong')).toBe(false);
    expect(checkAdminCredentials('other@x.com', 'hunter2')).toBe(false);
  });

  it('lowercases the email before comparison', () => {
    expect(checkAdminCredentials('ADMIN@example.com', 'hunter2')).toBe(true);
  });

  describe('ADMINS_CREDS JSON list', () => {
    beforeEach(() => {
      delete process.env.ADMIN_EMAIL;
      delete process.env.ADMIN_PASSWORD;
      process.env.ADMINS_CREDS = JSON.stringify([
        { email: 'admin1@example.com', password: 'ExamplePass1!' },
        { email: 'admin2@example.com', password: 'ExamplePass2!' },
      ]);
    });

    it('accepts any admin in the list', () => {
      expect(checkAdminCredentials('admin1@example.com', 'ExamplePass1!')).toBe(true);
      expect(checkAdminCredentials('admin2@example.com', 'ExamplePass2!')).toBe(true);
    });

    it('rejects wrong password for a listed admin', () => {
      expect(checkAdminCredentials('admin2@example.com', 'wrong')).toBe(false);
    });

    it('rejects an email not in the list', () => {
      expect(checkAdminCredentials('nobody@example.com', 'ExamplePass2!')).toBe(false);
    });

    it('lowercases the email before comparison', () => {
      expect(checkAdminCredentials('Admin2@Example.com', 'ExamplePass2!')).toBe(true);
    });

    it('falls back to legacy ADMIN_EMAIL/ADMIN_PASSWORD on malformed JSON', () => {
      process.env.ADMINS_CREDS = 'not json';
      process.env.ADMIN_EMAIL = 'admin@example.com';
      process.env.ADMIN_PASSWORD = 'hunter2';
      expect(checkAdminCredentials('admin@example.com', 'hunter2')).toBe(true);
    });
  });

  it('signs and verifies a session JWT, round-tripping the admin identity', async () => {
    const t = await signSessionJwt({ orgId: 'o-1', email: 'admin1@example.com', userId: 'u-1', name: 'Admin', userRole: 'owner' });
    const p = await verifySessionJwt(t);
    expect(p.orgId).toBe('o-1');
    expect(p.role).toBe('admin');
    expect(p.email).toBe('admin1@example.com');
    expect(p.userId).toBe('u-1');
    expect(p.name).toBe('Admin');
    expect(p.userRole).toBe('owner');
  });

  it('rejects a token with no email claim (forces re-login for legacy cookies)', async () => {
    const secret = new TextEncoder().encode(process.env.JWT_SECRET);
    const legacy = await new SignJWT({ role: 'admin', orgId: 'o-1' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('7d')
      .sign(secret);
    await expect(verifySessionJwt(legacy)).rejects.toThrow();
  });

  it('rejects a pre-users-management token missing userId (forces re-login)', async () => {
    const secret = new TextEncoder().encode(process.env.JWT_SECRET);
    const legacy = await new SignJWT({ role: 'admin', orgId: 'o-1', email: 'admin1@example.com' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('7d')
      .sign(secret);
    await expect(verifySessionJwt(legacy)).rejects.toThrow();
  });
});
