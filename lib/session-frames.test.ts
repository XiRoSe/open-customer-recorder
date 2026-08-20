import { describe, it, expect } from 'vitest';
import { pickFrameMoments } from './session-frames';
import type { SessionDigest } from './session-digest';

const T0 = 1_700_000_000_000;

function digest(partial: Partial<SessionDigest> & { steps: SessionDigest['steps'] }): SessionDigest {
  return {
    insights: [],
    stats: { durationMs: 0, activeMs: 0, pages: [], clickCount: 0, inputFieldCount: 0 },
    ...partial,
    stats: { durationMs: 0, activeMs: 0, pages: [], clickCount: 0, inputFieldCount: 0, ...partial.stats },
  } as SessionDigest;
}

describe('pickFrameMoments', () => {
  it('returns [] for an empty digest', () => {
    expect(pickFrameMoments(digest({ steps: [] }))).toEqual([]);
  });

  it('uses the first insight moment plus the final activity moment', () => {
    const d = digest({
      steps: [
        { t: T0, kind: 'nav', url: 'https://x.test/' },
        { t: T0 + 60_000, kind: 'click', label: 'Go', tag: 'button' },
      ],
      insights: [{ kind: 'dead_click', at: T0 + 10_000 }],
      stats: { durationMs: 60_000, activeMs: 60_000, pages: [], clickCount: 1, inputFieldCount: 0 },
    });
    expect(pickFrameMoments(d)).toEqual([10_000, 60_000]);
  });

  it('falls back to mid-session when there are no timestamped insights', () => {
    const d = digest({
      steps: [
        { t: T0, kind: 'nav', url: 'https://x.test/' },
        { t: T0 + 40_000, kind: 'click', label: 'Go', tag: 'button' },
      ],
      // pogo_stick uses at=0 (no single moment) — must be ignored
      insights: [{ kind: 'pogo_stick', at: 0, count: 2 }],
      stats: { durationMs: 40_000, activeMs: 40_000, pages: [], clickCount: 1, inputFieldCount: 0 },
    });
    expect(pickFrameMoments(d)).toEqual([20_000, 40_000]);
  });

  it('collapses to one frame when the moments are within 2s', () => {
    const d = digest({
      steps: [
        { t: T0, kind: 'nav', url: 'https://x.test/' },
        { t: T0 + 1_000, kind: 'click', label: 'Go', tag: 'button' },
      ],
      insights: [{ kind: 'dead_click', at: T0 + 500 }],
      stats: { durationMs: 1_000, activeMs: 1_000, pages: [], clickCount: 1, inputFieldCount: 0 },
    });
    expect(pickFrameMoments(d)).toEqual([1_000]);
  });

  it('clamps moments into [0, durationMs]', () => {
    const d = digest({
      steps: [
        { t: T0, kind: 'nav', url: 'https://x.test/' },
        { t: T0 + 90_000, kind: 'click', label: 'Go', tag: 'button' },
      ],
      insights: [{ kind: 'rage_click', at: T0 + 200_000 }], // beyond duration
      stats: { durationMs: 90_000, activeMs: 90_000, pages: [], clickCount: 1, inputFieldCount: 0 },
    });
    expect(pickFrameMoments(d)).toEqual([90_000]);
  });
});
