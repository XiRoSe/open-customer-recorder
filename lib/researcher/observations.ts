// Greeting observations: "while you were away I noticed…" — a
// deterministic ranked pick composed directly from the cached overview
// bundle (trends, spike buckets, segments, totals). Sentences are
// written for the drawer's conversational voice — NOT reused from the
// Overview's callout strings, which carry link-label phrasing that
// reads wrong in chat. No LLM; clicking one just asks the mapped
// question through the normal pipeline.
import { overviewForProject } from '@/lib/overview';
import { SOURCE_META } from '@/lib/traffic-source';

export interface Observation {
  /** Sentence with a {strong} placeholder the client renders bold. */
  text: string;
  strong: string;
  /** The question the drawer submits when the card is clicked. */
  question: string;
}

const cache = new Map<string, { at: number; observations: Observation[] }>();
const TTL_MS = 5 * 60 * 1000;

const fmtWhen = (ms: number, hourly: boolean): string => {
  const d = new Date(ms);
  return hourly
    ? d.toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })
    : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', timeZone: 'UTC' });
};

export async function observationsForProject(projectId: string): Promise<Observation[]> {
  const hit = cache.get(projectId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.observations;

  const o = await overviewForProject(projectId, '7d');
  const t = o.data.totals;
  const out: Observation[] = [];

  // Frustration trending up — the thing to look at first.
  const fru = o.data.trends.find((c) => c.label === 'Frustration');
  if (fru?.direction === 'up') {
    out.push({
      text: 'Frustration climbed to {strong} of sessions this week.',
      strong: fru.value,
      question: 'Which sessions had friction this week?',
    });
  }

  // Biggest traffic spike in the window.
  const hourly = o.data.bucketMs < 86_400_000;
  const spike = o.data.buckets.reduce<typeof o.data.buckets[number] | null>(
    (best, b) => (b.spike && (!best || b.spike.factor > best.spike!.factor) ? b : best), null);
  if (spike?.spike) {
    out.push({
      text: `${fmtWhen(spike.start, hourly)} ran {strong} — ${spike.total} sessions, mostly ${SOURCE_META[spike.spike.dominant].label.toLowerCase()}.`,
      strong: `${spike.spike.factor}× normal volume`,
      question: 'What caused the recent traffic spike?',
    });
  }

  // A traffic source gaining share.
  const emerging = o.data.trends.find((c) => c.label === 'Emerging source');
  if (emerging) {
    const sp = emerging.value.lastIndexOf(' ');
    const name = sp > 0 ? emerging.value.slice(0, sp) : emerging.value;
    const delta = sp > 0 ? emerging.value.slice(sp + 1) : '';
    out.push({
      text: `${name} traffic gained {strong} of share vs the previous week.`,
      strong: delta || 'share',
      question: 'Where is our traffic coming from this week?',
    });
  }

  // Most active segment.
  if (out.length < 3 && o.segments[0]) {
    const s = o.segments[0];
    out.push({
      text: `“${s.name}” was the most active segment — {strong} came back this week.`,
      strong: `${s.active} of ${s.size} members`,
      question: `Tell me about the ${s.name} segment`,
    });
  }

  // The week in one line.
  if (out.length < 3 && t.sessions > 0) {
    out.push({
      text: `The week so far: {strong}, ${t.newVisitors} of them first-time visitors.`,
      strong: `${t.sessions} sessions`,
      question: 'How are we doing this week?',
    });
  }

  if (out.length === 0) {
    out.push({
      text: '{strong} — no sessions recorded yet; once the tracker sees traffic, insights land here.',
      strong: 'Quiet week',
      question: 'How do I check the tracker is installed correctly?',
    });
  }
  const observations = out.slice(0, 3);
  cache.set(projectId, { at: Date.now(), observations });
  return observations;
}
