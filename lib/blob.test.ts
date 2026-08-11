import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { gzipSync } from 'node:zlib';
import { initBlobDir, appendSessionBlob, readSessionBlob, deleteSessionBlob, blobPathFor } from './blob';

let tmp: string;
const env = process.env;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'blob-test-'));
  process.env = { ...env, BLOB_DIR: tmp };
});
afterEach(() => {
  process.env = env;
  rmSync(tmp, { recursive: true, force: true });
});

describe('blob', () => {
  it('creates the sessions dir on init', async () => {
    await initBlobDir();
    expect(existsSync(path.join(tmp, 'sessions'))).toBe(true);
  });

  it('appends gzipped chunks and reads back as concatenated text', async () => {
    await initBlobDir();
    const id = 'sess-1';
    const chunk1 = gzipSync(Buffer.from('{"a":1}\n'));
    const chunk2 = gzipSync(Buffer.from('{"b":2}\n'));
    const total1 = await appendSessionBlob(id, chunk1);
    const total2 = await appendSessionBlob(id, chunk2);
    expect(total1).toBe(chunk1.length);
    expect(total2).toBe(chunk1.length + chunk2.length);
    const text = await readSessionBlob(id);
    expect(text).toBe('{"a":1}\n{"b":2}\n');
  });

  it('reports the correct relative blob path', () => {
    expect(blobPathFor('abc')).toBe('sessions/abc.ndjson.gz');
  });

  it('deletes a blob', async () => {
    await initBlobDir();
    await appendSessionBlob('sess-2', gzipSync(Buffer.from('x')));
    await deleteSessionBlob('sess-2');
    expect(existsSync(path.join(tmp, 'sessions/sess-2.ndjson.gz'))).toBe(false);
  });

  it('returns total byte count from stat', async () => {
    await initBlobDir();
    const buf = gzipSync(Buffer.from('hello'));
    await appendSessionBlob('sess-3', buf);
    expect(statSync(path.join(tmp, 'sessions/sess-3.ndjson.gz')).size).toBe(buf.length);
  });
});
