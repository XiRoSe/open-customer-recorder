import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resetDb, createOrgWithProject } from '@/tests/helpers';
import { isDbAvailable } from '@/tests/db-available';
import { db, schema } from '@/lib/db';
import { clusterVectors, representatives, silhouette, runClusteringOnce, segmentsForProject, clusterMapForProject, clustersDataForProject, filterDimsByVisitors, type DimensionData } from './user-segments';

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

describe('filterDimsByVisitors', () => {
  it('keeps only active visitors, recounts segment sizes, drops empties', () => {
    const dims: DimensionData[] = [{
      dimension: 'overall', analysis: '',
      segments: [
        { id: 'seg-a', name: 'A', description: '', analysis: '', size: 2 },
        { id: 'seg-b', name: 'B', description: '', analysis: '', size: 1 },
      ],
      points: [
        { visitorKey: 'v1', x: 0, y: 0, segmentId: 'seg-a', excerpt: '' },
        { visitorKey: 'v2', x: 1, y: 1, segmentId: 'seg-a', excerpt: '' },
        { visitorKey: 'v3', x: 2, y: 2, segmentId: 'seg-b', excerpt: '' },
      ],
    }];
    const out = filterDimsByVisitors(dims, new Set(['v1']));
    expect(out[0].points.map((p) => p.visitorKey)).toEqual(['v1']);
    expect(out[0].segments).toEqual([{ id: 'seg-a', name: 'A', description: '', analysis: '', size: 1 }]);
    // nobody active → the dimension disappears entirely
    expect(filterDimsByVisitors(dims, new Set(['nobody']))).toEqual([]);
  });
});

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
  choices: [{ message: { content: 'Name: Test Segment\nDescription: Visitors doing test things.\nAnalysis: They behave consistently and deserve a targeted fix.' } }],
}), { status: 200 });

async function seedProfiles(projectId: string, texts: string[], facetsList?: (object | null)[]) {
  for (let i = 0; i < texts.length; i++) {
    await db.insert(schema.userProfiles).values({
      projectId, visitorKey: `v${i}`, profileText: texts[i], sessionsSummarized: 2, status: 'done',
      facets: facetsList?.[i] ?? null,
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

  it('clusters each facet dimension and averages facet positions for overall', async () => {
    const { project } = await createOrgWithProject();
    const mk = (kind: string, i: number) => ({
      persona: `${kind} persona ${i}`, intent: `${kind} intent ${i}`,
      source: `${kind} source ${i}`, experience: `${kind} experience ${i}`,
    });
    await seedProfiles(project.id,
      ['shopper profile 0', 'shopper profile 1', 'shopper profile 2', 'builder profile 0', 'builder profile 1', 'builder profile 2'],
      [mk('shopper', 0), mk('shopper', 1), mk('shopper', 2), mk('builder', 0), mk('builder', 1), mk('builder', 2)],
    );
    const fetchFn = vi.fn(async () => nameResponse());
    expect(await runClusteringOnce(fakeEmbed, fetchFn as unknown as typeof fetch)).toBe(1);

    const dims = await clustersDataForProject(project.id);
    expect(dims.map((d) => d.dimension).sort()).toEqual(['experience', 'intent', 'overall', 'persona', 'source']);
    for (const d of dims) {
      expect(d.points).toHaveLength(6);
      expect(d.segments).toHaveLength(2);
      expect(d.analysis.length).toBeGreaterThan(0);
      expect(d.segments[0].analysis).toContain('targeted fix');
    }
    // Overall position = average of the visitor's facet positions.
    const overall = dims.find((d) => d.dimension === 'overall')!;
    const facetXs = dims.filter((d) => d.dimension !== 'overall')
      .map((d) => d.points.find((p) => p.visitorKey === 'v0')!.x);
    const avgX = facetXs.reduce((a, b) => a + b, 0) / facetXs.length;
    expect(overall.points.find((p) => p.visitorKey === 'v0')!.x).toBeCloseTo(avgX, 6);
    // Facet tooltips show the facet text, not the whole profile.
    const persona = dims.find((d) => d.dimension === 'persona')!;
    expect(persona.points.find((p) => p.visitorKey === 'v0')!.excerpt).toBe('shopper persona 0');
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
