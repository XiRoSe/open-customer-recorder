import { describe, expect, it } from 'vitest';
import { URL_CHANGE_TAG, buildUrlTimeline, hrefOf, makeUrlChangeEvent, urlAtTime } from './url-timeline';

const meta = (timestamp: number, href: string) => ({ type: 4, timestamp, data: { href, width: 800, height: 600 } });
const other = (timestamp: number) => ({ type: 3, timestamp, data: { source: 1 } });

describe('makeUrlChangeEvent', () => {
  it('builds a type-5 custom event with the shared tag', () => {
    expect(makeUrlChangeEvent('https://a.com/x', 123)).toEqual({
      type: 5,
      data: { tag: URL_CHANGE_TAG, payload: { href: 'https://a.com/x' } },
      timestamp: 123,
    });
  });
});

describe('buildUrlTimeline', () => {
  it('collects Meta hrefs in timestamp order', () => {
    const events = [meta(2000, 'https://a.com/two'), other(500), meta(1000, 'https://a.com/one')];
    expect(buildUrlTimeline(events)).toEqual([
      { timestamp: 1000, href: 'https://a.com/one' },
      { timestamp: 2000, href: 'https://a.com/two' },
    ]);
  });

  it('interleaves mega-url-change custom events with Meta events', () => {
    const events = [meta(1000, 'https://a.com/'), makeUrlChangeEvent('https://a.com/spa', 1500), meta(2000, 'https://a.com/next')];
    expect(buildUrlTimeline(events).map((e) => e.href)).toEqual([
      'https://a.com/',
      'https://a.com/spa',
      'https://a.com/next',
    ]);
  });

  it('ignores custom events with other tags and malformed payloads', () => {
    const events = [
      meta(1000, 'https://a.com/'),
      { type: 5, timestamp: 1100, data: { tag: 'mega-rrweb-error', payload: { message: 'x' } } },
      { type: 5, timestamp: 1200, data: { tag: URL_CHANGE_TAG, payload: {} } },
      { type: 5, timestamp: 1300, data: null },
      { type: 4, timestamp: 1400, data: {} },
    ];
    expect(buildUrlTimeline(events)).toEqual([{ timestamp: 1000, href: 'https://a.com/' }]);
  });

  it('drops consecutive duplicate hrefs', () => {
    const events = [meta(1000, 'https://a.com/'), makeUrlChangeEvent('https://a.com/', 1500), makeUrlChangeEvent('https://a.com/b', 2000)];
    expect(buildUrlTimeline(events).map((e) => e.href)).toEqual(['https://a.com/', 'https://a.com/b']);
  });

  it('returns [] for empty input', () => {
    expect(buildUrlTimeline([])).toEqual([]);
  });
});

describe('hrefOf', () => {
  it('extracts href from a Meta event', () => {
    expect(hrefOf(meta(1000, 'https://a.com/'))).toBe('https://a.com/');
  });

  it('extracts href from a mega-url-change event', () => {
    expect(hrefOf(makeUrlChangeEvent('https://a.com/spa', 1500))).toBe('https://a.com/spa');
  });

  it('returns null for unrelated event types and malformed payloads', () => {
    expect(hrefOf(other(500))).toBeNull();
    expect(hrefOf({ type: 5, timestamp: 1, data: { tag: 'mega-rrweb-error', payload: {} } })).toBeNull();
    expect(hrefOf({ type: 4, timestamp: 1, data: {} })).toBeNull();
  });
});

describe('urlAtTime', () => {
  const tl = [
    { timestamp: 1000, href: 'https://a.com/one' },
    { timestamp: 2000, href: 'https://a.com/two' },
    { timestamp: 3000, href: 'https://a.com/three' },
  ];

  it('returns null for an empty timeline', () => {
    expect(urlAtTime([], 1234)).toBeNull();
  });

  it('returns the first entry before playback reaches it', () => {
    expect(urlAtTime(tl, 500)).toBe('https://a.com/one');
  });

  it('returns the entry active at exact timestamps and between entries', () => {
    expect(urlAtTime(tl, 1000)).toBe('https://a.com/one');
    expect(urlAtTime(tl, 1999)).toBe('https://a.com/one');
    expect(urlAtTime(tl, 2000)).toBe('https://a.com/two');
    expect(urlAtTime(tl, 2500)).toBe('https://a.com/two');
  });

  it('returns the last entry after the final navigation', () => {
    expect(urlAtTime(tl, 99999)).toBe('https://a.com/three');
  });
});
