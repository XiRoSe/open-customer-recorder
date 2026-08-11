import { mkdir, appendFile, readFile, stat, unlink } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';

function root() {
  return process.env.BLOB_DIR || './data';
}

export function blobPathFor(sessionId: string) {
  return `sessions/${sessionId}.ndjson.gz`;
}

function fullPath(sessionId: string) {
  return path.join(root(), blobPathFor(sessionId));
}

export async function initBlobDir() {
  await mkdir(path.join(root(), 'sessions'), { recursive: true });
}

export async function appendSessionBlob(sessionId: string, gzippedChunk: Buffer): Promise<number> {
  await initBlobDir();
  const p = fullPath(sessionId);
  await appendFile(p, gzippedChunk);
  const s = await stat(p);
  return s.size;
}

export async function readSessionBlob(sessionId: string): Promise<string> {
  const buf = await readFile(fullPath(sessionId));
  return gunzipSync(buf).toString('utf8');
}

export async function readSessionBlobBuffer(sessionId: string): Promise<Buffer> {
  return await readFile(fullPath(sessionId));
}

export async function deleteSessionBlob(sessionId: string): Promise<void> {
  try {
    await unlink(fullPath(sessionId));
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
}
