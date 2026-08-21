// Multi-dimensional behavioral segmentation. Each visitor profile
// carries four research facets (persona / intent / source / experience);
// every facet is its own clustering space — embedded (MiniLM,
// in-process), clustered (bisecting k-means with a separation-ratio
// split test), PCA-projected for the map, and explained (segment
// analysis + a batch-level dimension read) by the summarizer LLM.
// 'overall' clusters the full profile text and positions each visitor at
// the AVERAGE of their facet points.
import { kmeans } from 'ml-kmeans';
import { sql, and, eq, inArray, isNotNull } from 'drizzle-orm';
import { db, schema } from '@/lib/db';
import { getAppSettings } from './app-settings';
import { embedTexts, type EmbedFn } from './embeddings';
import { pca2d } from './pca';
import type { ProfileFacets } from './user-profiles';

export const FACET_DIMENSIONS = ['persona', 'intent', 'source', 'experience'] as const;
export type FacetDimension = (typeof FACET_DIMENSIONS)[number];
export type Dimension = FacetDimension | 'overall';

export const MIN_PROFILES_TO_CLUSTER = 4;
const MAX_K = 8;
const REPRESENTATIVES = 6;
const NAME_TIMEOUT_MS = 60_000;

// Bisecting parameters: a split must produce two real groups (each
// ≥ MIN_SEGMENT_SIZE) whose centroids are clearly farther apart than
// the groups are wide (separation ratio, Dunn-style). Silhouette can't
// be the test here — it's scale-free, so even a homogeneous cluster
// bisects at ~0.5.
export const MIN_SEGMENT_SIZE = 3;
const SPLIT_SEPARATION = 1.7;

function dist2(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; s += d * d; }
  return s;
}

/** Mean silhouette over all points; higher = better-separated clusters. */
export function silhouette(vectors: number[][], labels: number[], k: number): number {
  if (k < 2) return -1;
  const byCluster = new Map<number, number[]>();
  labels.forEach((l, i) => { (byCluster.get(l) ?? byCluster.set(l, []).get(l)!).push(i); });
  if (byCluster.size < 2) return -1;
  let total = 0;
  for (let i = 0; i < vectors.length; i++) {
    const own = byCluster.get(labels[i])!;
    const a = own.length > 1
      ? own.reduce((s, j) => (j === i ? s : s + Math.sqrt(dist2(vectors[i], vectors[j]))), 0) / (own.length - 1)
      : 0;
    let b = Infinity;
    for (const [label, members] of byCluster) {
      if (label === labels[i]) continue;
      const d = members.reduce((s, j) => s + Math.sqrt(dist2(vectors[i], vectors[j])), 0) / members.length;
      if (d < b) b = d;
    }
    total += own.length > 1 ? (b - a) / Math.max(a, b) : 0;
  }
  return total / vectors.length;
}

export interface ClusterResult { labels: number[]; centroids: number[][]; k: number }

function centroidOf(vectors: number[][], members: number[]): number[] {
  const d = vectors[0].length;
  const c = new Array(d).fill(0);
  for (const i of members) for (let j = 0; j < d; j++) c[j] += vectors[i][j] / members.length;
  return c;
}

function avgDistToCentroid(vectors: number[][], members: number[], c: number[]): number {
  return members.reduce((s, i) => s + Math.sqrt(dist2(vectors[i], c)), 0) / members.length;
}

/** Bisecting k-means: recursively split the least-coherent cluster,
 * judging each split locally — so small actionable groups surface even
 * beside a large majority, and homogeneous data stays one segment. */
export function clusterVectors(vectors: number[][]): ClusterResult {
  if (vectors.length === 0) throw new Error('not enough vectors to cluster');
  const all = vectors.map((_, i) => i);
  const clusters: number[][] = [all];
  const unsplittable = new Set<number>();

  while (clusters.length < MAX_K) {
    let candidate = -1;
    let worst = -Infinity;
    clusters.forEach((members, idx) => {
      if (unsplittable.has(idx) || members.length < 2 * MIN_SEGMENT_SIZE) return;
      const spread = avgDistToCentroid(vectors, members, centroidOf(vectors, members));
      if (spread > worst) { worst = spread; candidate = idx; }
    });
    if (candidate === -1) break;

    const members = clusters[candidate];
    const sub = members.map((i) => vectors[i]);
    const r = kmeans(sub, 2, { initialization: 'kmeans++', seed: 7 });
    const a = members.filter((_, i) => r.clusters[i] === 0);
    const b = members.filter((_, i) => r.clusters[i] === 1);
    let clean = a.length >= MIN_SEGMENT_SIZE && b.length >= MIN_SEGMENT_SIZE;
    if (clean) {
      const cA = centroidOf(vectors, a);
      const cB = centroidOf(vectors, b);
      const separation = Math.sqrt(dist2(cA, cB));
      const width = avgDistToCentroid(vectors, a, cA) + avgDistToCentroid(vectors, b, cB);
      clean = separation / Math.max(width, 1e-9) >= SPLIT_SEPARATION;
    }
    if (!clean) { unsplittable.add(candidate); continue; }

    clusters.splice(candidate, 1, a, b);
    unsplittable.clear();
  }

  const labels = new Array(vectors.length).fill(0);
  clusters.forEach((members, label) => members.forEach((i) => { labels[i] = label; }));
  return { labels, centroids: clusters.map((m) => centroidOf(vectors, m)), k: clusters.length };
}

/** Indices of the members closest to their centroid, per cluster. */
export function representatives(vectors: number[][], result: ClusterResult, perCluster = REPRESENTATIVES): number[][] {
  return result.centroids.map((c, label) => {
    const members = result.labels.map((l, i) => ({ l, i })).filter((m) => m.l === label).map((m) => m.i);
    return members.sort((a, b) => dist2(vectors[a], c) - dist2(vectors[b], c)).slice(0, perCluster);
  });
}

// --- LLM: segment naming + dimension analysis --------------------------------

async function llmCall(system: string, user: string, fetchFn: typeof fetch, maxTokens: number): Promise<string | null> {
  const baseUrl = process.env.SUMMARIZER_URL;
  if (!baseUrl) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), NAME_TIMEOUT_MS);
  try {
    const res = await fetchFn(`${baseUrl.replace(/\/$/, '')}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: ctrl.signal,
      body: JSON.stringify({
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        max_tokens: maxTokens,
        temperature: 0.3,
      }),
    });
    if (!res.ok) throw new Error(`summarizer ${res.status}`);
    const json = await res.json() as { choices?: { message?: { content?: string } }[] };
    return json.choices?.[0]?.message?.content?.trim() || null;
  } catch (e) {
    console.warn('[segments] llm call failed', e instanceof Error ? e.message : e);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function nameSegment(dimension: Dimension, memberTexts: string[], fetchFn: typeof fetch): Promise<{ name: string; description: string; analysis: string } | null> {
  const text = await llmCall(
    `You are an expert researcher of website visitors and buyers, naming a segment found on the "${dimension}" dimension from sample member descriptions. Reply with exactly three lines:
Name: <2-4 word segment name>
Description: <one sentence - what unites these visitors>
Analysis: <2-3 sentences - what this group means for the site and the most useful action to take>`,
    memberTexts.map((t, i) => `${i + 1}. ${t}`).join('\n'),
    fetchFn, 240,
  );
  if (!text) return null;
  const name = /Name:\s*(.+)/i.exec(text)?.[1]?.trim();
  const description = /Description:\s*(.+)/i.exec(text)?.[1]?.trim() ?? '';
  const analysis = /Analysis:\s*([\s\S]+)/i.exec(text)?.[1]?.trim() ?? '';
  return name ? { name: name.slice(0, 60), description: description.slice(0, 300), analysis: analysis.slice(0, 700) } : null;
}

async function analyzeDimension(dimension: Dimension, cohortSize: number, segs: { name: string; size: number; description: string }[], fetchFn: typeof fetch): Promise<string> {
  const text = await llmCall(
    `You are an expert researcher of website visitors and buyers. Given the segments found on the "${dimension}" dimension for a cohort, write a concise 2-3 sentence analyst read: what this dimension reveals about the cohort and the single most important implication. Plain text, no preamble.`,
    `Cohort of ${cohortSize} visitors. Segments:\n${segs.map((s) => `- ${s.name} (${s.size}): ${s.description}`).join('\n')}`,
    fetchFn, 160,
  );
  return (text ?? '').slice(0, 700);
}

// --- the clustering run -------------------------------------------------------

interface ProfileRow { id: string; visitorKey: string; profileText: string; facets: ProfileFacets | null }

async function clusterOneDimension(
  projectId: string,
  dimension: Dimension,
  items: { profile: ProfileRow; text: string }[],
  embedFn: EmbedFn,
  fetchFn: typeof fetch,
): Promise<Map<string, { segmentId: string; x: number; y: number }>> {
  const vectors = await embedFn(items.map((i) => i.text));
  const result = clusterVectors(vectors);
  const reps = representatives(vectors, result);

  const named = await Promise.all(reps.map(async (idxs, label) => {
    const fromLlm = await nameSegment(dimension, idxs.map((i) => items[i].text), fetchFn);
    return fromLlm ?? { name: `Segment ${label + 1}`, description: '', analysis: '' };
  }));
  const sizes = result.labels.reduce<Record<number, number>>((acc, l) => { acc[l] = (acc[l] ?? 0) + 1; return acc; }, {});
  const inserted = await db.insert(schema.userSegments).values(
    named.map((n, label) => ({ projectId, dimension, name: n.name, description: n.description, analysis: n.analysis, size: sizes[label] ?? 0 })),
  ).returning({ id: schema.userSegments.id });

  const analysis = await analyzeDimension(dimension, items.length, named.map((n, label) => ({ ...n, size: sizes[label] ?? 0 })), fetchFn);
  await db.insert(schema.dimensionAnalyses)
    .values({ projectId, dimension, analysis })
    .onConflictDoUpdate({
      target: [schema.dimensionAnalyses.projectId, schema.dimensionAnalyses.dimension],
      set: { analysis, builtAt: new Date() },
    });

  const coords = pca2d(vectors);
  const out = new Map<string, { segmentId: string; x: number; y: number }>();
  items.forEach((item, i) => {
    out.set(item.profile.id, { segmentId: inserted[result.labels[i]].id, x: coords[i][0], y: coords[i][1] });
  });
  return out;
}

/** Recluster every project whose profiles changed: each facet dimension
 * plus 'overall'. Returns the number of projects reclustered. */
export async function runClusteringOnce(embedFn: EmbedFn = embedTexts, fetchFn: typeof fetch = fetch): Promise<number> {
  const settings = await getAppSettings();
  if (!settings.clusteringEnabled || !settings.profilesEnabled) return 0;

  interface Stale extends Record<string, unknown> { project_id: string }
  const res = await db.execute<Stale>(sql`
    SELECT p.project_id
    FROM ${schema.userProfiles} p
    LEFT JOIN (
      SELECT project_id, max(created_at) AS built_at FROM ${schema.userSegments} GROUP BY 1
    ) seg ON seg.project_id = p.project_id
    WHERE p.status = 'done' AND p.profile_text IS NOT NULL
    GROUP BY p.project_id, seg.built_at
    HAVING count(*) >= ${MIN_PROFILES_TO_CLUSTER}
       AND (seg.built_at IS NULL OR max(p.updated_at) > seg.built_at)
  `);
  const stale: Stale[] = Array.isArray(res) ? res : (res as unknown as { rows: Stale[] }).rows ?? [];

  let reclustered = 0;
  for (const { project_id: projectId } of stale) {
    const rows = await db.select({
      id: schema.userProfiles.id,
      visitorKey: schema.userProfiles.visitorKey,
      profileText: schema.userProfiles.profileText,
      facets: schema.userProfiles.facets,
    }).from(schema.userProfiles)
      .where(and(eq(schema.userProfiles.projectId, projectId), eq(schema.userProfiles.status, 'done')));
    const profiles = rows.filter((p): p is typeof p & { profileText: string } => Boolean(p.profileText))
      .map((p) => ({ ...p, facets: (p.facets ?? null) as ProfileFacets | null }));
    if (profiles.length < MIN_PROFILES_TO_CLUSTER) continue;

    // Replace the project's segments wholesale (all dimensions).
    await db.delete(schema.userSegments).where(eq(schema.userSegments.projectId, projectId));

    // Facet dimensions.
    const facetPoints = new Map<FacetDimension, Map<string, { segmentId: string; x: number; y: number }>>();
    for (const dim of FACET_DIMENSIONS) {
      const items = profiles.filter((p) => p.facets?.[dim]).map((p) => ({ profile: p, text: p.facets![dim]! }));
      if (items.length < MIN_PROFILES_TO_CLUSTER) continue;
      const points = await clusterOneDimension(projectId, dim, items, embedFn, fetchFn);
      facetPoints.set(dim, points);
      for (const [profileId, pt] of points) {
        await db.insert(schema.profileDimensionPoints)
          .values({ profileId, dimension: dim, segmentId: pt.segmentId, x: pt.x, y: pt.y })
          .onConflictDoUpdate({
            target: [schema.profileDimensionPoints.profileId, schema.profileDimensionPoints.dimension],
            set: { segmentId: pt.segmentId, x: pt.x, y: pt.y },
          });
      }
    }

    // Overall: cluster the full profile text; position = average of the
    // visitor's facet points where available.
    const overall = await clusterOneDimension(projectId, 'overall',
      profiles.map((p) => ({ profile: p, text: p.profileText })), embedFn, fetchFn);
    for (const p of profiles) {
      const own = overall.get(p.id)!;
      const facetPts = FACET_DIMENSIONS.map((d) => facetPoints.get(d)?.get(p.id)).filter((v): v is NonNullable<typeof v> => Boolean(v));
      const x = facetPts.length >= 2 ? facetPts.reduce((s, v) => s + v.x, 0) / facetPts.length : own.x;
      const y = facetPts.length >= 2 ? facetPts.reduce((s, v) => s + v.y, 0) / facetPts.length : own.y;
      await db.update(schema.userProfiles)
        .set({ segmentId: own.segmentId, mapX: x, mapY: y })
        .where(eq(schema.userProfiles.id, p.id));
    }

    reclustered++;
    console.log(`[segments] reclustered project ${projectId}: ${1 + facetPoints.size} dimensions over ${profiles.length} profiles`);
  }
  return reclustered;
}

// --- reads --------------------------------------------------------------------

export interface Segment { id: string; name: string; description: string; analysis: string; size: number }

export async function segmentsForProject(projectId: string, dimension: Dimension = 'overall'): Promise<Segment[]> {
  const rows = await db.select({
    id: schema.userSegments.id, name: schema.userSegments.name,
    description: schema.userSegments.description, analysis: schema.userSegments.analysis,
    size: schema.userSegments.size,
  }).from(schema.userSegments)
    .where(and(eq(schema.userSegments.projectId, projectId), eq(schema.userSegments.dimension, dimension)));
  return rows.sort((a, b) => b.size - a.size);
}

export interface ClusterPoint {
  visitorKey: string;
  x: number;
  y: number;
  segmentId: string | null;
  excerpt: string;
}

export interface DimensionData {
  dimension: Dimension;
  analysis: string;
  segments: Segment[];
  points: ClusterPoint[];
}

/** Everything the Clusters page needs, per dimension (only dimensions
 * that actually have points; 'overall' first). */
export async function clustersDataForProject(projectId: string): Promise<DimensionData[]> {
  const [allSegments, analysesRows, overallRows, facetRows] = await Promise.all([
    db.select().from(schema.userSegments).where(eq(schema.userSegments.projectId, projectId)),
    db.select().from(schema.dimensionAnalyses).where(eq(schema.dimensionAnalyses.projectId, projectId)),
    db.select({
      visitorKey: schema.userProfiles.visitorKey,
      mapX: schema.userProfiles.mapX,
      mapY: schema.userProfiles.mapY,
      segmentId: schema.userProfiles.segmentId,
      profileText: schema.userProfiles.profileText,
    }).from(schema.userProfiles)
      .where(and(eq(schema.userProfiles.projectId, projectId), isNotNull(schema.userProfiles.mapX))),
    db.select({
      dimension: schema.profileDimensionPoints.dimension,
      segmentId: schema.profileDimensionPoints.segmentId,
      x: schema.profileDimensionPoints.x,
      y: schema.profileDimensionPoints.y,
      visitorKey: schema.userProfiles.visitorKey,
      facets: schema.userProfiles.facets,
    }).from(schema.profileDimensionPoints)
      .innerJoin(schema.userProfiles, eq(schema.userProfiles.id, schema.profileDimensionPoints.profileId))
      .where(eq(schema.userProfiles.projectId, projectId)),
  ]);

  const analysisOf = new Map(analysesRows.map((a) => [a.dimension, a.analysis]));
  const segmentsOf = (dim: string): Segment[] => allSegments
    .filter((s) => s.dimension === dim)
    .map((s) => ({ id: s.id, name: s.name, description: s.description, analysis: s.analysis, size: s.size }))
    .sort((a, b) => b.size - a.size);

  const out: DimensionData[] = [];
  const overallPoints: ClusterPoint[] = overallRows
    .filter((r): r is typeof r & { mapX: number; mapY: number } => r.mapX !== null && r.mapY !== null)
    .map((r) => ({
      visitorKey: r.visitorKey, x: r.mapX, y: r.mapY, segmentId: r.segmentId,
      excerpt: (r.profileText ?? '').slice(0, 160),
    }));
  if (overallPoints.length > 0) {
    out.push({ dimension: 'overall', analysis: analysisOf.get('overall') ?? '', segments: segmentsOf('overall'), points: overallPoints });
  }
  for (const dim of FACET_DIMENSIONS) {
    const points = facetRows.filter((r) => r.dimension === dim).map((r) => ({
      visitorKey: r.visitorKey, x: r.x, y: r.y, segmentId: r.segmentId,
      excerpt: (((r.facets ?? {}) as ProfileFacets)[dim] ?? '').slice(0, 160),
    }));
    if (points.length > 0) {
      out.push({ dimension: dim, analysis: analysisOf.get(dim) ?? '', segments: segmentsOf(dim), points });
    }
  }
  return out;
}

/** Positioned profiles for the (overall) cluster map — kept for tests
 * and simple consumers. */
export async function clusterMapForProject(projectId: string): Promise<ClusterPoint[]> {
  const data = await clustersDataForProject(projectId);
  return data.find((d) => d.dimension === 'overall')?.points ?? [];
}
