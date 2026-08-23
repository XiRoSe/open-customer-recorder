// Greeting observations: "while you were away I noticed…" — a
// deterministic ranked pick over data the platform already caches
// (attention items, segments, noteworthy sessions). No LLM, no new
// queries beyond the overview bundle; clicking one just asks the
// mapped question through the normal pipeline.
import { overviewForProject } from '@/lib/overview';

export interface Observation {
  text: string;
  strong: string;
  /** The question the drawer submits when the card is clicked. */
  question: string;
}

const cache = new Map<string, { at: number; observations: Observation[] }>();
const TTL_MS = 5 * 60 * 1000;

export async function observationsForProject(projectId: string): Promise<Observation[]> {
  const hit = cache.get(projectId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.observations;

  const o = await overviewForProject(projectId, '7d');
  const out: Observation[] = [];

  for (const a of o.attention.slice(0, 3)) {
    out.push({
      text: a.text,
      strong: a.strong,
      question: a.kind === 'friction' ? 'Which sessions had friction this week?'
        : a.kind === 'spike' ? 'What caused the recent traffic spike?'
        : a.kind === 'sources' ? 'Where is our traffic coming from this week?'
        : a.kind === 'segments' ? 'What are our visitor segments up to?'
        : 'How are we trending this week?',
    });
  }
  if (out.length < 3 && o.segments[0]) {
    const s = o.segments[0];
    out.push({
      text: `“${s.name}” is the most active segment — {strong} this week.`,
      strong: `${s.active} of ${s.size} visitors`,
      question: `Tell me about the ${s.name} segment`,
    });
  }
  if (out.length < 3 && o.data.totals.sessions > 0) {
    const t = o.data.totals;
    out.push({
      text: `The week so far: {strong}, ${t.newVisitors} of them first-time visitors.`,
      strong: `${t.sessions} sessions`,
      question: 'How are we doing this week?',
    });
  }
  if (out.length === 0) {
    out.push({
      text: 'No sessions recorded yet this week — once the tracker sees traffic, insights land here.',
      strong: 'Quiet week',
      question: 'How do I check the tracker is installed correctly?',
    });
  }
  const observations = out.slice(0, 3);
  cache.set(projectId, { at: Date.now(), observations });
  return observations;
}
