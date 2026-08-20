import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resetDb, createOrgWithProject } from '@/tests/helpers';
import { isDbAvailable } from '@/tests/db-available';
import { db, schema } from '@/lib/db';
import { clusterVectors, representatives, silhouette, runClusteringOnce, segmentsForProject, clusterMapForProject } from './user-segments';

const dbReady = await isDbAvailable();
beforeEach(async () => {
  if (!dbReady) return;
  await resetDb();
  process.env.SUMMARIZER_URL = 'http://summarizer.test:8080';
});
afterEach(() => { delete process.env.SUMMARIZER_URL; });

// Two tight, well-separated blobs on the unit circle. Every point gets a
// unique jitter — duplicated points let silhouette degenerately reward
// singleton clusters, which real embeddings never do.
function twoBlobs(n = 6): { vectors: number[][]; labelsTruth: number[] } {
  const vectors: number[][] = [];
  const labelsTruth: number[] = [];
  for (let i = 0; i < n; i++) {
    const jitter = i * 0.005;
    vectors.push([1 - jitter, jitter]);      // blob A near (1, 0)
    labelsTruth.push(0);
    vectors.push([jitter + 0.002, 1 - jitter - 0.002]); // blob B near (0, 1)
    labelsTruth.push(1);
  }
  return { vectors, labelsTruth };
}

describe('clustering math', () => {
  it('finds k=2 for two clean blobs and separates them', () => {
    const { vectors } = twoBlobs();
    const r = clusterVectors(vectors);
    expect(r.k).toBe(2);
    // All even indices (blob A) share a label; all odd share the other.
    const a = new Set(r.labels.filter((_, i) => i % 2 === 0));
    const b = new Set(r.labels.filter((_, i) => i % 2 === 1));
    expect(a.size).toBe(1);
    expect(b.size).toBe(1);
    expect([...a][0]).not.toBe([...b][0]);
  });

  it('silhouette scores clean separation higher than a bad split', () => {
    const { vectors } = twoBlobs();
    const good = clusterVectors(vectors);
    const goodScore = silhouette(vectors, good.labels, good.k);
    const badLabels = vectors.map((_, i) => (i < vectors.length / 2 ? 0 : 1)); // mixes blobs
    expect(goodScore).toBeGreaterThan(silhouette(vectors, badLabels, 2));
  });

  it('representatives returns members closest to each centroid', () => {
    const { vectors } = twoBlobs();
    const r = clusterVectors(vectors);
    const reps = representatives(vectors, r, 3);
    expect(reps).toHaveLength(2);
    for (const idxs of reps) {
      expect(idxs.length).toBeGreaterThan(0);
      const labels = new Set(idxs.map((i) => r.labels[i]));
      expect(labels.size).toBe(1); // reps come from one cluster each
    }
  });
});

// Fake embedder: "shopper" texts → near (1,0), "builder" texts → near (0,1).
const fakeEmbed = async (texts: string[]) =>
  texts.map((t, i) => (t.includes('shopper') ? [1 - i * 0.001, i * 0.001] : [i * 0.001, 1 - i * 0.001]));

const nameResponse = () => new Response(JSON.stringify({
  choices: [{ message: { content: 'Name: Test Segment\nDescription: Visitors doing test things.' } }],
}), { status: 200 });

async function seedProfiles(projectId: string, texts: string[]) {
  for (let i = 0; i < texts.length; i++) {
    await db.insert(schema.userProfiles).values({
      projectId, visitorKey: `v${i}`, profileText: texts[i], sessionsSummarized: 2, status: 'done',
    });
  }
}

describe.skipIf(!dbReady)('runClusteringOnce', () => {
  it('clusters profiles, names segments via the LLM, links profiles', async () => {
    const { project } = await createOrgWithProject();
    await seedProfiles(project.id, [
      'shopper comparing prices', 'shopper hunting deals', 'shopper reading reviews',
      'builder configuring dashboards', 'builder managing operations', 'builder automating tasks',
    ]);
    const fetchFn = vi.fn(async () => nameResponse());
    expect(await runClusteringOnce(fakeEmbed, fetchFn as unknown as typeof fetch)).toBe(1);
    const segments = await segmentsForProject(project.id);
    expect(segments).toHaveLength(2);
    expect(segments[0].name).toBe('Test Segment');
    expect(segments.reduce((s, x) => s + x.size, 0)).toBe(6);
    const profiles = await db.select().from(schema.userProfiles);
    expect(profiles.every((p) => p.segmentId !== null)).toBe(true);
    // Map coordinates were stored for the cluster map.
    const points = await clusterMapForProject(project.id);
    expect(points).toHaveLength(6);
    for (const p of points) {
      expect(Math.abs(p.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(p.y)).toBeLessThanOrEqual(1);
      expect(p.segmentId).not.toBeNull();
      expect(p.excerpt.length).toBeGreaterThan(0);
    }
  });

  it('is a no-op when profiles have not changed since the last run', async () => {
    const { project } = await createOrgWithProject();
    await seedProfiles(project.id, [
      'shopper a', 'shopper b', 'builder a', 'builder b',
    ]);
    const fetchFn = vi.fn(async () => nameResponse());
    expect(await runClusteringOnce(fakeEmbed, fetchFn as unknown as typeof fetch)).toBe(1);
    expect(await runClusteringOnce(fakeEmbed, fetchFn as unknown as typeof fetch)).toBe(0);
  });

  it('skips projects with fewer than the minimum profiles', async () => {
    const { project } = await createOrgWithProject();
    await seedProfiles(project.id, ['shopper a', 'builder a', 'shopper b']);
    expect(await runClusteringOnce(fakeEmbed, vi.fn() as unknown as typeof fetch)).toBe(0);
  });

  it('falls back to generic names when the summarizer is unreachable', async () => {
    const { project } = await createOrgWithProject();
    await seedProfiles(project.id, ['shopper a', 'shopper b', 'builder a', 'builder b']);
    const fetchFn = vi.fn(async () => new Response('boom', { status: 500 }));
    expect(await runClusteringOnce(fakeEmbed, fetchFn as unknown as typeof fetch)).toBe(1);
    const segments = await segmentsForProject(project.id);
    expect(segments.map((s) => s.name).sort()).toEqual(['Segment 1', 'Segment 2']);
  });

  it('respects the clusteringEnabled toggle', async () => {
    const { updateAppSettings } = await import('./app-settings');
    const { org, project } = await createOrgWithProject();
    await seedProfiles(project.id, ['shopper a', 'shopper b', 'builder a', 'builder b']);
    await updateAppSettings(org.id, { clusteringEnabled: false });
    expect(await runClusteringOnce(fakeEmbed, vi.fn() as unknown as typeof fetch)).toBe(0);
  });
});
