import { describe, it, expect } from 'vitest';
import {
  MAX_SESSION_DURATION_MS,
  cappedDurationMs,
  splitAtCap,
  isSessionExpired,
} from './session-cap';

describe('session-cap', () => {
  describe('cappedDurationMs', () => {
    it('returns the event span when under the cap', () => {
      expect(cappedDurationMs(1000, 1000 + 120_000)).toBe(120_000);
    });

    it('clamps to the 5-minute cap', () => {
      expect(cappedDurationMs(1000, 1000 + 179 * 60_000)).toBe(MAX_SESSION_DURATION_MS);
    });

    it('never goes negative when the latest event predates startedAt', () => {
      expect(cappedDurationMs(5000, 1000)).toBe(0);
    });
  });

  describe('splitAtCap', () => {
    it('drops events past startedAt + cap and flags droppedAny', () => {
      const started = 1000;
      const events = [
        { ts: started + 10_000 },
        { ts: started + MAX_SESSION_DURATION_MS }, // exactly at cutoff -> kept
        { ts: started + MAX_SESSION_DURATION_MS + 1 }, // past cutoff -> dropped
      ];
      const { kept, droppedAny } = splitAtCap(events, started);
      expect(kept).toHaveLength(2);
      expect(droppedAny).toBe(true);
    });

    it('keeps events with no timestamp', () => {
      const { kept, droppedAny } = splitAtCap([{ ts: null }], 1000);
      expect(kept).toHaveLength(1);
      expect(droppedAny).toBe(false);
    });

    it('keeps everything when all events are within the cap', () => {
      const started = 1000;
      const { kept, droppedAny } = splitAtCap(
        [{ ts: started + 1 }, { ts: started + 2 }],
        started,
      );
      expect(kept).toHaveLength(2);
      expect(droppedAny).toBe(false);
    });
  });

  describe('isSessionExpired', () => {
    it('is true once the session is older than the cap (resume starts fresh)', () => {
      const started = 1000;
      expect(isSessionExpired(started, started + MAX_SESSION_DURATION_MS)).toBe(true);
      expect(isSessionExpired(started, started + 179 * 60_000)).toBe(true);
    });

    it('is false while within the cap (resume keeps the session)', () => {
      const started = 1000;
      expect(isSessionExpired(started, started + 60_000)).toBe(false);
    });
  });
});
