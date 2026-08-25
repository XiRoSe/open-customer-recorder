import { describe, it, expect, beforeEach } from 'vitest';
import { POST } from './route';
import { resetDb } from '@/tests/helpers';
import { isDbAvailable } from '@/tests/db-available';
import { db, schema } from '@/lib/db';

const dbReady = await isDbAvailable();

beforeEach(async () => { if (dbReady) await resetDb(); });

function post(body: Record<string, unknown>) {
  return POST(new Request('http://localhost/api/contact', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

describe.skipIf(!dbReady)('POST /api/contact', () => {
  it('stores a valid lead', async () => {
    const res = await post({ name: 'Ada Lovelace', email: 'ada@example.com', message: 'Building an analytical engine.' });
    expect(res.status).toBe(200);
    const rows = await db.select().from(schema.leads);
    expect(rows.length).toBe(1);
    expect(rows[0].name).toBe('Ada Lovelace');
    expect(rows[0].email).toBe('ada@example.com');
    // No RESEND_API_KEY in the test env — stored but not notified.
    expect(rows[0].notified).toBe(false);
  });

  it('rejects a missing or invalid email', async () => {
    expect((await post({ name: 'A', email: 'not-an-email', message: 'hi' })).status).toBe(400);
    expect((await post({ name: 'A', message: 'hi' })).status).toBe(400);
    expect((await db.select().from(schema.leads)).length).toBe(0);
  });

  it('answers 200 to a honeypot submission but stores nothing', async () => {
    const res = await post({ name: 'Bot', email: 'bot@example.com', message: 'spam', company: 'Bots Inc' });
    expect(res.status).toBe(200);
    expect((await db.select().from(schema.leads)).length).toBe(0);
  });
});
