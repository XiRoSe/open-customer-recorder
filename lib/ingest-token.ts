import { SignJWT, jwtVerify } from 'jose';

const ALG = 'HS256';
const TTL_SECONDS = 60 * 60 * 2; // 2 hours

function secret(): Uint8Array {
  const s = process.env.INGEST_TOKEN_SECRET;
  if (!s) throw new Error('INGEST_TOKEN_SECRET is required');
  return new TextEncoder().encode(s);
}

export interface IngestTokenPayload {
  sessionId: string;
  projectId: string;
}

export async function signIngestToken(p: IngestTokenPayload): Promise<string> {
  return new SignJWT({ ...p })
    .setProtectedHeader({ alg: ALG })
    .setIssuedAt()
    .setExpirationTime(`${TTL_SECONDS}s`)
    .sign(secret());
}

export async function verifyIngestToken(token: string): Promise<IngestTokenPayload> {
  const { payload } = await jwtVerify(token, secret());
  if (typeof payload.sessionId !== 'string' || typeof payload.projectId !== 'string') {
    throw new Error('invalid ingest token payload');
  }
  return { sessionId: payload.sessionId, projectId: payload.projectId };
}
