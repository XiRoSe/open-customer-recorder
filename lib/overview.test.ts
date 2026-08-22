import { describe, it, expect } from 'vitest';
import { worstFrictionEntry, attentionItems } from './overview';
import { buildTimeline, type TimelineSessionRow } from './timeline';

const HOUR = 3600_000;
const END = 1_700_000_000_000;
const WINDOW = 24 * HOUR;

function row(hoursAgo: number, over: Partial<TimelineSessionRow> = {}): TimelineSessionRow {
  const at = new Date(END - hoursAgo * HOUR);
  return {
    startedAt: at, durationMs: 5_000, referrer: null, pageUrl: 'https://x.test/',
    visitorKey: `v-${hoursAgo}`, firstSeenAt: at, frustrated: false,
    ...over,
  };
}

describe('worstFrictionEntry', () => {
  it('finds the entry path with the highest friction rate (min 5 sessions, min 20%)', () => {
    const rows = [
      // /login: 6 sessions, 3 frustrated → 50%
      ...Array.from({ length: 3 }, (_, i) => row(2 + i * 0.1, { pageUrl: 'https://x.test/login', frustrated: true })),
      ...Array.from({ length: 3 }, (_, i) => row(3 + i * 0.1, { pageUrl: 'https://x.test/login' })),
      // /: 10 sessions, 1 frustrated → 10% (below threshold)
      ...Array.from({ length: 9 }, (_, i) => row(4 + i * 0.1)),
      row(5.9, { frustrated: true }),
      // /rare: 2 sessions, both frustrated → too few to matter
      row(6, { pageUrl: 'https://x.test/rare', frustrated: true }),
      row(6.1, { pageUrl: 'https://x.test/rare', frustrated: true }),
    ];
    const w = worstFrictionEntry(rows, END - WINDOW, END);
    expect(w).toEqual({ path: '/login', rate: 50, sessions: 6 });
  });

  it('returns null when nothing crosses the bar', () => {
    const rows = Array.from({ length: 8 }, (_, i) => row(2 + i * 0.1));
    expect(worstFrictionEntry(rows, END - WINDOW, END)).toBeNull();
  });
});

describe('attentionItems', () => {
  it('leads with friction, links the spike to its exact slice, caps at 4', () => {
    const rows = [
      ...Array.from({ length: 8 }, (_, i) => row(20 - i * 2 + 0.5)),
      ...Array.from({ length: 6 }, (_, i) => row(3.5, { visitorKey: `s${i}` })),
    ];
    const data = buildTimeline(rows, END, WINDOW, HOUR);
    const items = attentionItems(
      data, '/p/sessions', '/p/timeline', '/p/clusters', '7d',
      { path: '/login', rate: 40, sessions: 10 },
      { name: 'Builders', description: '', active: 3, size: 9, colorIndex: 0 },
    );
    expect(items.length).toBeLessThanOrEqual(4);
    expect(items[0].kind).toBe('friction');
    expect(items[0].strong).toContain('/login');
    const spike = items.find((i) => i.kind === 'spike')!;
    expect(spike.href).toContain('/p/sessions?from=');
    const seg = items.find((i) => i.kind === 'segments');
    if (seg) expect(seg.text).toContain('3 of 9');
  });

  it('yields nothing when the window is unremarkable', () => {
    const rows = Array.from({ length: 6 }, (_, i) => row(2 + i, { visitorKey: `u${i}` }));
    const data = buildTimeline(rows, END, WINDOW, HOUR);
    const items = attentionItems(data, '/s', '/t', '/c', '7d', null, null);
    expect(items.filter((i) => i.kind === 'friction')).toHaveLength(0);
    expect(items.filter((i) => i.kind === 'segments')).toHaveLength(0);
  });
});
