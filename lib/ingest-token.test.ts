import { describe, it, expect, beforeEach } from 'vitest';
import { signIngestToken, verifyIngestToken } from './ingest-token';

beforeEach(() => {
  process.env.INGEST_TOKEN_SECRET = 'test-secret-must-be-long-enough-aaaa';
});

describe('ingest-token', () => {
  it('signs and verifies a token', async () => {
    const token = await signIngestToken({ sessionId: 's1', projectId: 'p1' });
    expect(token).toMatch(/^eyJ/);
    const payload = await verifyIngestToken(token);
    expect(payload.sessionId).toBe('s1');
    expect(payload.projectId).toBe('p1');
  });

  it('rejects tokens with the wrong secret', async () => {
    const token = await signIngestToken({ sessionId: 's1', projectId: 'p1' });
    process.env.INGEST_TOKEN_SECRET = 'a-different-secret-also-long-enough-aa';
    await expect(verifyIngestToken(token)).rejects.toThrow();
  });

  it('rejects garbage', async () => {
    await expect(verifyIngestToken('not-a-token')).rejects.toThrow();
  });
});
