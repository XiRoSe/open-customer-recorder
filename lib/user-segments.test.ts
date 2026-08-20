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

// Gaussian-ish 2D cloud around a center — deterministic pseudo-jitter in
// both dimensions. Line-shaped fixtures are adversarial (a uniform line
// always "looks" bisectable to any geometric criterion); real embedding
// clusters are cloud-shaped.
function cloud(cx: number, cy: number, n: number, spread = 0.02): number[][] {
  return Array.from({ length: n }, (_, i) => [
    cx + spread * Math.sin(3 + i * 2.39),
    cy + spread * Math.cos(1 + i * 1.71),
  ]);
}

function twoBlobs(n = 6): { vectors: number[][] } {
  const a = cloud(1, 0, n);
  const b = cloud(0, 1, n);
  // interleave: even indices = blob A, odd = blob B
  const vectors: number[][] = [];
  for (let i = 0; i < n; i++) { vectors.push(a[i], b[i]); }
  return { vectors };
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

  it('surfaces small minority groups hiding beside a large majority', () => {
    // 24-point majority cloud + two 4-point minority clouds. A single
    // global-silhouette k pick collapses toward the majority split;
    // bisecting must find all three groups.
    const vectors = [
      ...cloud(1, 0, 24),
      ...cloud(0, 1, 4),
      ...cloud(-1, 0, 4),
    ];
    const r = clusterVectors(vectors);
    expect(r.k).toBe(3);
    const majorityLabels = new Set(r.labels.slice(0, 24));
    const bLabels = new Set(r.labels.slice(24, 28));
    const cLabels = new Set(r.labels.slice(28, 32));
    expect(majorityLabels.size).toBe(1);
    expect(bLabels.size).toBe(1);
    expect(cLabels.size).toBe(1);
    expect(new Set([...majorityLabels, ...bLabels, ...cLabels]).size).toBe(3);
  });

  it('does not shred a homogeneous population into fake segments', () => {
    const r = clusterVectors(cloud(1, 0, 12));
    expect(r.k).toBe(1);
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
    await seedProfiles(project.id, ['shopper a', 'shopper b', 'shopper c', 'builder a', 'builder b', 'builder c']);
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
