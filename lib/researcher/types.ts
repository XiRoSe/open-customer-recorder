// Shared shapes for the Researcher: the read-only AI drawer that answers
// questions over sessions, visitors, timeline, and clusters. Client-safe —
// no db or node imports here (the two type-only imports below erase at
// compile time and pull no server code into the browser bundle).
import type { TimelineBucket, TimelinePatterns } from '@/lib/timeline';
import type { DimensionData } from '@/lib/user-segments';

/** One row in an EVIDENCE block: label + count, bar scaled to max. */
export interface EvidenceRow { label: string; value: number; display?: string }

export type ResearcherBlock =
  | { type: 'evidence'; title: string; rows: EvidenceRow[] }
  | { type: 'sessions'; title: string; items: SessionItem[] }
  | { type: 'table'; title: string; columns: string[]; rows: string[][] }
  | { type: 'tagDraft'; draftId: string; name: string; kind: string; value: string; color: string; matchCount: number; approx: boolean }
  // Rich boxes — the full-screen workspace (and the share page) embed
  // the app's REAL TimelineChart / ClusterMap with this data; the
  // drawer skips them and keeps its compact previews.
  | { type: 'chart'; title: string; windowNote: string; bucketMs: number; buckets: TimelineBucket[]; tagMeta: Record<string, { color: string }>; initialMetric: string | null; href: string }
  | { type: 'clusterMap'; title: string; windowNote: string; dims: DimensionData[]; initialDimension: string | null; initialSegment: string | null; href: string }
  | { type: 'analysis'; title: string; text: string; patterns: TimelinePatterns | null };

export interface SessionItem {
  id: string;
  startedAt: string; // ISO
  durationMs: number | null;
  pages: number;
  country: string | null;
  browser: string | null;
  /** One-line AI intent or deterministic narrative, when available. */
  note: string | null;
  frustrated: boolean;
  tags: { name: string; color: string }[];
}

/** Provenance chip: what was actually queried to get a figure. */
export interface Citation { label: string; detail: string; href: string | null }

/** One research step as shown in the footprints strip. */
export interface Footprint { name: string; label: string; ms: number }

/** Everything an assistant message renders beyond its prose. */
export interface AssistantPayload {
  blocks: ResearcherBlock[];
  citations: Citation[];
  caveat: string | null;
  followups: string[];
  footprints: Footprint[];
  /** The answer's brass view-nav deep link — opens the exact dashboard
   * view (filtered timeline / cluster map / session list) behind the
   * figures. */
  link?: { label: string; href: string } | null;
  /** Set when the user hit stop mid-stream. */
  interrupted?: boolean;
}

/** SSE events, in emission order: meta → tool* → block* → token* → done. */
export type ResearcherEvent =
  | { type: 'meta'; threadId: string; title: string }
  | { type: 'tool'; name: string; label: string; status: 'start' | 'done' | 'error'; ms?: number }
  | { type: 'block'; block: ResearcherBlock }
  | { type: 'token'; text: string }
  | { type: 'done'; messageId: string; content: string; payload: AssistantPayload }
  | { type: 'busy'; message: string }
  | { type: 'error'; message: string };

/** The router's output: which tools to run with which arguments. */
export interface ResearchPlan {
  intent: string;
  /** Answer purely from conversation history — no tools. */
  fromHistory: boolean;
  steps: { tool: string; args: Record<string, unknown> }[];
  /** Set when the question asks for a tag: executor previews, human applies. */
  tagDraft: { name: string; kind: 'url_contains' | 'session_count_gte'; value: string; color: string } | null;
}

export const RESEARCHER_RANGES = ['24h', '7d', '30d', 'all'] as const;
export type ResearcherRange = (typeof RESEARCHER_RANGES)[number];

export interface ThreadSummary {
  id: string;
  title: string;
  lastMessageAt: string;
  /** First line of the last assistant answer — the "what it found" line. */
  finding: string | null;
}

export interface ThreadMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  payload: AssistantPayload | null;
  createdAt: string;
}
