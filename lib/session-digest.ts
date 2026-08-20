// Deterministic "session → words" extractor. One O(n) pass over a
// session's decompressed rrweb NDJSON. Dependency-free (same discipline
// as lib/url-timeline.ts). Never reads input VALUES — only field
// names/labels/placeholders.
import { hrefOf, type RawEvent } from './url-timeline';

export const DIGEST_VERSION = 1;

export type Step =
  | { t: number; kind: 'nav'; url: string }
  | { t: number; kind: 'click'; label: string; tag: string }
  | { t: number; kind: 'input'; field: string }
  | { t: number; kind: 'idle'; ms: number };

export interface Insight { kind: string; at: number; detail?: string; count?: number }
export interface PageStat { url: string; ms: number; maxScrollY: number }
export interface SessionDigest {
  steps: Step[];
  insights: Insight[];
  stats: { durationMs: number; activeMs: number; pages: PageStat[]; clickCount: number; inputFieldCount: number };
}

const MAX_LINES = 200_000;
const MAX_NODES = 50_000;
const MAX_STEPS = 60;
const IDLE_GAP_MS = 30_000;
const LABEL_MAX = 60;

interface NodeInfo { tag: string; label: string; parentId: number }

// --- serialized rrweb node tree -> label map -------------------------------

interface SerializedNode {
  type: number; id: number; tagName?: string; textContent?: string;
  attributes?: Record<string, unknown>; childNodes?: SerializedNode[];
}

function attrLabel(attrs: Record<string, unknown> | undefined): string {
  if (!attrs) return '';
  for (const key of ['aria-label', 'title', 'alt', 'placeholder', 'name']) {
    const v = attrs[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

function descendantText(node: SerializedNode, depth: number): string {
  if (depth > 3) return '';
  if (node.type === 3) return (node.textContent || '').trim();
  let out = '';
  for (const c of node.childNodes || []) {
    out += ' ' + descendantText(c, depth + 1);
    if (out.length > LABEL_MAX * 2) break;
  }
  return out.replace(/\s+/g, ' ').trim();
}

function indexTree(node: SerializedNode, parentId: number, nodes: Map<number, NodeInfo>) {
  if (nodes.size >= MAX_NODES || typeof node.id !== 'number') return;
  if (node.type === 2 && node.tagName) {
    const label = descendantText(node, 0) || attrLabel(node.attributes);
    nodes.set(node.id, { tag: node.tagName.toLowerCase(), label: label.slice(0, LABEL_MAX), parentId });
    for (const c of node.childNodes || []) indexTree(c, node.id, nodes);
  } else {
    for (const c of node.childNodes || []) indexTree(c, parentId, nodes);
  }
}

/** Resolve a clicked/typed node id to {tag, label}. Walk up ≤6 nodes:
 * a button/a ancestor wins (it's the interactive element the user meant),
 * otherwise the first labeled node on the way up, otherwise a tag fallback. */
function resolve(nodes: Map<number, NodeInfo>, id: number): { tag: string; label: string } {
  let cur = nodes.get(id);
  if (!cur) return { tag: 'unknown', label: '<unknown>' };
  const selfTag = cur.tag;
  let firstLabel = '';
  for (let i = 0; i < 6 && cur; i++) {
    if (cur.tag === 'button' || cur.tag === 'a') {
      return { tag: cur.tag, label: cur.label || firstLabel || `<${cur.tag}>` };
    }
    if (!firstLabel && cur.label) firstLabel = cur.label;
    cur = nodes.get(cur.parentId);
  }
  return { tag: selfTag, label: firstLabel || `<${selfTag}>` };
}

// --- main pass --------------------------------------------------------------

interface ClickEvt { t: number; id: number; x: number; y: number; tag: string; label: string }

export function extractDigest(ndjson: string): SessionDigest {
  const events: RawEvent[] = [];
  let lines = 0;
  for (const raw of ndjson.split('\n')) {
    if (!raw.trim() || ++lines > MAX_LINES) continue;
    try {
      const e = JSON.parse(raw) as RawEvent;
      if (typeof e.type === 'number' && typeof e.timestamp === 'number') events.push(e);
    } catch { /* tolerate truncated/corrupt lines */ }
  }
  events.sort((a, b) => a.timestamp - b.timestamp);

  const nodes = new Map<number, NodeInfo>();
  const steps: Step[] = [];
  const insights: Insight[] = [];
  const clicks: ClickEvt[] = [];
  const pages: PageStat[] = [];
  const inputFirstSeen = new Map<string, number>(); // field label -> first ts
  let lastInputField = '';
  let lastInputTs = 0;
  let lastUrl = '';
  let lastMetaHref = '';
  let lastMetaTs = 0;
  let refreshRun = 1;
  let idleMs = 0;
  let lastTs = 0;
  let clickCount = 0;
  const t0 = events.length ? events[0].timestamp : 0;
  let lastNavTs = t0;

  const closePage = (t: number) => {
    if (pages.length) pages[pages.length - 1].ms = t - Math.max(t0, lastNavTs);
  };

  // Timestamps of "the page did something" events (mutation/nav/input) —
  // used for dead-click verdicts in Task 2's heuristics.
  const effects: number[] = [];

  for (const e of events) {
    const t = e.timestamp;
    if (lastTs && t - lastTs > IDLE_GAP_MS) {
      steps.push({ t: lastTs, kind: 'idle', ms: t - lastTs });
      idleMs += t - lastTs;
    }
    lastTs = t;

    // Navigation (Meta + custom url-change), deduped on same URL.
    const href = hrefOf(e);
    if (href) {
      if (e.type === 4) {
        // refresh loop: repeated full loads of the same URL within 30s
        if (href === lastMetaHref && t - lastMetaTs <= 30_000) {
          refreshRun++;
          if (refreshRun === 2) insights.push({ kind: 'refresh_loop', at: t, detail: href, count: 2 });
          else { const last = insights[insights.length - 1]; if (last?.kind === 'refresh_loop') last.count = refreshRun; }
        } else refreshRun = 1;
        lastMetaHref = href; lastMetaTs = t;
      }
      if (href !== lastUrl) {
        closePage(t);
        steps.push({ t, kind: 'nav', url: href });
        pages.push({ url: href, ms: 0, maxScrollY: 0 });
        lastUrl = href; lastNavTs = t;
        effects.push(t);
      }
      continue;
    }

    if (e.type === 2) {
      const node = (e.data as { node?: SerializedNode } | undefined)?.node;
      if (node) indexTree(node, 0, nodes);
      continue;
    }

    if (e.type !== 3) continue;
    const d = e.data as { source?: number } & Record<string, unknown>;
    switch (d.source) {
      case 0: { // Mutation
        const adds = (d.adds as { parentId: number; node: SerializedNode }[] | undefined) || [];
        for (const a of adds) indexTree(a.node, a.parentId, nodes);
        const removes = (d.removes as { id: number }[] | undefined) || [];
        for (const r of removes) nodes.delete(r.id);
        effects.push(t);
        break;
      }
      case 2: { // MouseInteraction — Click only
        if ((d as { type?: number }).type !== 2) break;
        const id = d.id as number;
        const { tag, label } = resolve(nodes, id);
        clicks.push({ t, id, x: (d.x as number) ?? 0, y: (d.y as number) ?? 0, tag, label });
        clickCount++;
        steps.push({ t, kind: 'click', label, tag });
        break;
      }
      case 3: { // Scroll
        if (pages.length) pages[pages.length - 1].maxScrollY = Math.max(pages[pages.length - 1].maxScrollY, (d.y as number) || 0);
        break;
      }
      case 5: { // Input — field identity only, NEVER the value
        const { tag, label } = resolve(nodes, d.id as number);
        const field = label && !label.startsWith('<') ? label : `<${tag}>`;
        effects.push(t);
        if (field !== lastInputField || t - lastInputTs > 10_000) {
          steps.push({ t, kind: 'input', field });
          if (!inputFirstSeen.has(field)) inputFirstSeen.set(field, t);
        }
        lastInputField = field; lastInputTs = t;
        break;
      }
    }
  }
  closePage(lastTs);

  const durationMs = events.length ? lastTs - t0 : 0;
  const digest: SessionDigest = {
    steps: elide(steps),
    insights,
    stats: {
      durationMs,
      activeMs: Math.max(0, durationMs - idleMs),
      pages,
      clickCount,
      inputFieldCount: inputFirstSeen.size,
    },
  };
  addClickInsights(digest, clicks, effects, lastTs);
  addNavInsights(digest);
  addFormInsights(digest, clicks, inputFirstSeen, lastInputField, lastInputTs, lastTs);
  digest.insights.sort((a, b) => a.at - b.at);
  return digest;
}

function elide(steps: Step[]): Step[] {
  if (steps.length <= MAX_STEPS) return steps;
  const head = steps.slice(0, MAX_STEPS - 10);
  const tail = steps.slice(-9);
  return [...head, { t: tail[0].t, kind: 'idle', ms: 0 }, ...tail].slice(0, MAX_STEPS);
}

// Heuristic insight passes — implemented in Task 2.
function addClickInsights(_d: SessionDigest, _clicks: ClickEvt[], _effects: number[], _endTs: number) {}
function addNavInsights(_d: SessionDigest) {}
function addFormInsights(_d: SessionDigest, _clicks: ClickEvt[], _fields: Map<string, number>, _lastField: string, _lastInputTs: number, _endTs: number) {}
