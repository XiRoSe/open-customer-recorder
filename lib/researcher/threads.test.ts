import { describe, it, expect } from 'vitest';
import { payloadContext } from './threads';
import type { AssistantPayload } from './types';

const base: AssistantPayload = { blocks: [], citations: [], caveat: null, followups: [], footprints: [] };

describe('payloadContext', () => {
  it('returns empty for a null or block-less payload', () => {
    expect(payloadContext(null)).toBe('');
    expect(payloadContext(base)).toBe('');
  });

  it('renders session ids with duration, browser, and the frustrated flag', () => {
    const ctx = payloadContext({
      ...base,
      blocks: [{
        type: 'sessions', title: 'Sessions to watch',
        items: [
          { id: 'aaaa-1', startedAt: '', durationMs: 245_000, pages: 3, country: null, browser: 'Chrome', note: null, frustrated: false, tags: [] },
          { id: 'bbbb-2', startedAt: '', durationMs: 61_000, pages: 1, country: null, browser: 'Safari', note: null, frustrated: true, tags: [] },
          { id: 'cccc-3', startedAt: '', durationMs: null, pages: 1, country: null, browser: null, note: null, frustrated: false, tags: [] },
        ],
      }],
    });
    expect(ctx).toContain('aaaa-1 (4m5s, Chrome)');
    expect(ctx).toContain('bbbb-2 (1m1s, Safari, frustrated)');
    expect(ctx).toContain('+1 more'); // only the first two ids are spelled out
    expect(ctx.startsWith('[showed: ')).toBe(true);
  });

  it('renders segment names with sizes from the initial dimension', () => {
    const ctx = payloadContext({
      ...base,
      blocks: [{
        type: 'clusterMap', title: 'Segments', windowNote: 'all time',
        dims: [
          { dimension: 'overall', analysis: '', segments: [{ id: '1', name: 'Quiet Browsers', description: '', analysis: '', size: 8 }], points: [] },
          { dimension: 'persona', analysis: '', segments: [{ id: '2', name: 'Frantic Integrators', description: '', analysis: '', size: 12 }], points: [] },
        ] as never,
        initialDimension: 'persona', initialSegment: null, href: '/x',
      }],
    });
    expect(ctx).toContain('segments [persona]: Frantic Integrators (12)');
  });

  it('renders evidence rows, tag drafts, and the deep link', () => {
    const ctx = payloadContext({
      ...base,
      link: { label: 'Open timeline', href: '/projects/p/timeline?range=7d' },
      blocks: [
        { type: 'evidence', title: 'Traffic sources', rows: [{ label: 'search', value: 41 }, { label: 'direct', value: 12 }] },
        { type: 'tagDraft', draftId: 'd', name: 'Pricing visitors', kind: 'url_contains', value: 'pricing', color: 'blue', matchCount: 17, approx: false },
      ],
    });
    expect(ctx).toContain('Traffic sources: search=41, direct=12');
    expect(ctx).toContain('tag draft "Pricing visitors": url_contains=pricing (~17 sessions)');
    expect(ctx).toContain('view: /projects/p/timeline?range=7d');
  });

  it('never exceeds the 500-char cap', () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({ label: `label-${i}-${'x'.repeat(30)}`, value: i }));
    const ctx = payloadContext({ ...base, blocks: [{ type: 'evidence', title: 'Big', rows }] });
    expect(ctx.length).toBeLessThanOrEqual(500);
  });
});
