// Behavioral segmentation of visitors: embed profile texts (MiniLM,
// in-process), k-means with silhouette-picked k, then the summarizer LLM
// names each segment from its most representative profiles. Runs
// entirely in-app; a full run over hundreds of profiles is seconds of
// math plus one short LLM call per segment.
import { kmeans } from 'ml-kmeans';
import { sql, and, eq, inArray } from 'drizzle-orm';
import { db, schema } from '@/lib/db';
import { getAppSettings } from './app-settings';
import { embedTexts, type EmbedFn } from './embeddings';

export const MIN_PROFILES_TO_CLUSTER = 4;
const MAX_K = 8;
const REPRESENTATIVES = 6;
const NAME_TIMEOUT_MS = 60_000;

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

/** k-means over unit vectors with k chosen by silhouette (2..MAX_K). */
export function clusterVectors(vectors: number[][]): ClusterResult {
  const kMax = Math.min(MAX_K, Math.floor(vectors.length / 2));
  let best: ClusterResult | null = null;
  let bestScore = -Infinity;
  for (let k = 2; k <= kMax; k++) {
    const r = kmeans(vectors, k, { initialization: 'kmeans++', seed: 7 });
    const score = silhouette(vectors, r.clusters, k);
    if (score > bestScore) {
      bestScore = score;
      best = { labels: r.clusters, centroids: r.centroids, k };
    }
  }
  if (!best) throw new Error('not enough vectors to cluster');
  return best;
}

/** Indices of the members closest to their centroid, per cluster. */
export function representatives(vectors: number[][], result: ClusterResult, perCluster = REPRESENTATIVES): number[][] {
  return result.centroids.map((c, label) => {
    const members = result.labels.map((l, i) => ({ l, i })).filter((m) => m.l === label).map((m) => m.i);
    return members.sort((a, b) => dist2(vectors[a], c) - dist2(vectors[b], c)).slice(0, perCluster);
  });
}

async function nameSegment(profileTexts: string[], fetchFn: typeof fetch): Promise<{ name: string; description: string } | null> {
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
        messages: [
          {
            role: 'system',
            content: 'You name a behavioral segment of website visitors from a sample of their profiles. Reply with exactly two lines:\nName: <2-4 word segment name>\nDescription: <one sentence describing what unites these visitors>',
          },
          { role: 'user', content: profileTexts.map((t, i) => `${i + 1}. ${t}`).join('\n') },
        ],
        max_tokens: 90,
        temperature: 0.3,
      }),
    });
    if (!res.ok) throw new Error(`summarizer ${res.status}`);
    const json = await res.json() as { choices?: { message?: { content?: string } }[] };
    const text = json.choices?.[0]?.message?.content ?? '';
    const name = /Name:\s*(.+)/i.exec(text)?.[1]?.trim();
    const description = /Description:\s*(.+)/i.exec(text)?.[1]?.trim();
    return name ? { name: name.slice(0, 60), description: (description ?? '').slice(0, 300) } : null;
  } catch (e) {
    console.warn('[segments] naming failed', e instanceof Error ? e.message : e);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Recluster every project whose profiles changed since its segments were
 * built. Returns the number of projects reclustered. */
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
    const profiles = await db.select({ id: schema.userProfiles.id, profileText: schema.userProfiles.profileText })
      .from(schema.userProfiles)
      .where(and(eq(schema.userProfiles.projectId, projectId), eq(schema.userProfiles.status, 'done')));
    const usable = profiles.filter((p): p is { id: string; profileText: string } => Boolean(p.profileText));
    if (usable.length < MIN_PROFILES_TO_CLUSTER) continue;

    const vectors = await embedFn(usable.map((p) => p.profileText));
    const result = clusterVectors(vectors);
    const reps = representatives(vectors, result);

    const named = await Promise.all(reps.map(async (idxs, label) => {
      const fromLlm = await nameSegment(idxs.map((i) => usable[i].profileText), fetchFn);
      return fromLlm ?? { name: `Segment ${label + 1}`, description: '' };
    }));

    // Replace the project's segments wholesale; profile links cascade to
    // NULL and are re-set below.
    await db.delete(schema.userSegments).where(eq(schema.userSegments.projectId, projectId));
    const sizes = result.labels.reduce<Record<number, number>>((acc, l) => { acc[l] = (acc[l] ?? 0) + 1; return acc; }, {});
    const inserted = await db.insert(schema.userSegments).values(
      named.map((n, label) => ({ projectId, name: n.name, description: n.description, size: sizes[label] ?? 0 })),
    ).returning({ id: schema.userSegments.id });

    for (let label = 0; label < result.k; label++) {
      const memberIds = usable.filter((_, i) => result.labels[i] === label).map((p) => p.id);
      if (memberIds.length > 0) {
        await db.update(schema.userProfiles)
          .set({ segmentId: inserted[label].id })
          .where(inArray(schema.userProfiles.id, memberIds));
      }
    }
    reclustered++;
    console.log(`[segments] reclustered project ${projectId}: k=${result.k} over ${usable.length} profiles`);
  }
  return reclustered;
}

export interface Segment { id: string; name: string; description: string; size: number }

export async function segmentsForProject(projectId: string): Promise<Segment[]> {
  const rows = await db.select({
    id: schema.userSegments.id, name: schema.userSegments.name,
    description: schema.userSegments.description, size: schema.userSegments.size,
  }).from(schema.userSegments).where(eq(schema.userSegments.projectId, projectId));
  return rows.sort((a, b) => b.size - a.size);
}
