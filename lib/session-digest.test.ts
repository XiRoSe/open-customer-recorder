import { describe, it, expect } from 'vitest';
import { extractDigest, DIGEST_VERSION } from './session-digest';

const T0 = 1_700_000_000_000;

function el(id: number, tagName: string, attributes: Record<string, string> = {}, childNodes: unknown[] = []) {
  return { type: 2, id, tagName, attributes, childNodes };
}
function txt(id: number, textContent: string) {
  return { type: 3, id, textContent };
}
function fullSnapshot(t: number, bodyChildren: unknown[]) {
  return { type: 2, timestamp: t, data: { node: { type: 0, id: 1, childNodes: [el(2, 'html', {}, [el(3, 'body', {}, bodyChildren)])] } } };
}
function meta(t: number, href: string) {
  return { type: 4, timestamp: t, data: { href } };
}
function click(t: number, id: number, x = 100, y = 100) {
  return { type: 3, timestamp: t, data: { source: 2, type: 2, id, x, y } };
}
function input(t: number, id: number) {
  return { type: 3, timestamp: t, data: { source: 5, id, text: '***' } };
}
function mutationAdd(t: number, parentId: number, node: unknown) {
  return { type: 3, timestamp: t, data: { source: 0, adds: [{ parentId, nextId: null, node }], removes: [], texts: [], attributes: [] } };
}
function scroll(t: number, id: number, y: number) {
  return { type: 3, timestamp: t, data: { source: 3, id, x: 0, y } };
}
function ndjsonOf(events: unknown[]): string {
  return events.map((e) => JSON.stringify(e)).join('\n') + '\n';
}

describe('extractDigest steps', () => {
  it('resolves click labels from descendant text', () => {
    const d = extractDigest(ndjsonOf([
      meta(T0, 'https://x.test/home'),
      fullSnapshot(T0, [el(10, 'button', {}, [txt(11, 'Pricing')])]),
      click(T0 + 1000, 10),
    ]));
    expect(d.steps).toContainEqual({ t: T0 + 1000, kind: 'click', label: 'Pricing', tag: 'button' });
  });

  it('falls back to aria-label, then bare tag', () => {
    const d = extractDigest(ndjsonOf([
      meta(T0, 'https://x.test/'),
      fullSnapshot(T0, [el(10, 'button', { 'aria-label': 'Close dialog' }), el(20, 'div')]),
      click(T0 + 100, 10),
      click(T0 + 5000, 20),
    ]));
    const clicks = d.steps.filter((s) => s.kind === 'click');
    expect(clicks[0]).toMatchObject({ label: 'Close dialog' });
    expect(clicks[1]).toMatchObject({ label: '<div>', tag: 'div' });
  });

  it('uses nearest button/a ancestor label for unlabeled targets', () => {
    const d = extractDigest(ndjsonOf([
      meta(T0, 'https://x.test/'),
      fullSnapshot(T0, [el(10, 'a', { href: '/signup' }, [el(11, 'span', {}, [txt(12, 'Sign up')])])]),
      click(T0 + 100, 11),
    ]));
    expect(d.steps.filter((s) => s.kind === 'click')[0]).toMatchObject({ label: 'Sign up', tag: 'a' });
  });

  it('does not let layout containers donate text to unlabeled descendants', () => {
    const d = extractDigest(ndjsonOf([
      meta(T0, 'https://x.test/'),
      // hero div contains a labeled button AND a bare decorative div
      fullSnapshot(T0, [el(20, 'div', {}, [el(21, 'button', {}, [txt(22, 'Start free trial')]), el(23, 'div')])]),
      click(T0 + 100, 23),
    ]));
    expect(d.steps.filter((s) => s.kind === 'click')[0]).toMatchObject({ label: '<div>', tag: 'div' });
  });

  it('labels nodes added by later mutations', () => {
    const d = extractDigest(ndjsonOf([
      meta(T0, 'https://x.test/'),
      fullSnapshot(T0, [el(10, 'div')]),
      mutationAdd(T0 + 500, 10, el(30, 'button', {}, [txt(31, 'Buy now')])),
      click(T0 + 1000, 30),
    ]));
    expect(d.steps.filter((s) => s.kind === 'click')[0]).toMatchObject({ label: 'Buy now' });
  });

  it('emits nav steps from meta + url-change events, deduped', () => {
    const d = extractDigest(ndjsonOf([
      meta(T0, 'https://x.test/home'),
      fullSnapshot(T0, []),
      { type: 5, timestamp: T0 + 2000, data: { tag: 'mega-url-change', payload: { href: 'https://x.test/pricing' } } },
    ]));
    expect(d.steps.filter((s) => s.kind === 'nav').map((s) => (s as { url: string }).url))
      .toEqual(['https://x.test/home', 'https://x.test/pricing']);
  });

  it('emits input steps with field label, never values, deduping bursts on the same field', () => {
    const d = extractDigest(ndjsonOf([
      meta(T0, 'https://x.test/'),
      fullSnapshot(T0, [el(10, 'input', { placeholder: 'Email', value: 'SECRET' })]),
      input(T0 + 100, 10), input(T0 + 200, 10), input(T0 + 300, 10),
    ]));
    const inputs = d.steps.filter((s) => s.kind === 'input');
    expect(inputs).toEqual([{ t: T0 + 100, kind: 'input', field: 'Email' }]);
    expect(JSON.stringify(d)).not.toContain('SECRET');
  });

  it('emits idle steps for gaps > 30s and computes activeMs', () => {
    const d = extractDigest(ndjsonOf([
      meta(T0, 'https://x.test/'),
      fullSnapshot(T0, [el(10, 'button', {}, [txt(11, 'Go')])]),
      click(T0 + 1000, 10),
      click(T0 + 61_000, 10),
    ]));
    expect(d.steps.filter((s) => s.kind === 'idle')).toEqual([{ t: T0 + 1000, kind: 'idle', ms: 60_000 }]);
    expect(d.stats.durationMs).toBe(61_000);
    expect(d.stats.activeMs).toBe(1_000);
  });

  it('tracks per-page time and max scroll depth', () => {
    const d = extractDigest(ndjsonOf([
      meta(T0, 'https://x.test/home'),
      fullSnapshot(T0, [el(10, 'div')]),
      scroll(T0 + 1000, 1, 800),
      { type: 5, timestamp: T0 + 10_000, data: { tag: 'mega-url-change', payload: { href: 'https://x.test/pricing' } } },
      scroll(T0 + 12_000, 1, 300),
    ]));
    expect(d.stats.pages).toEqual([
      { url: 'https://x.test/home', ms: 10_000, maxScrollY: 800 },
      { url: 'https://x.test/pricing', ms: 2_000, maxScrollY: 300 },
    ]);
  });
});

describe('extractDigest durability', () => {
  it('skips malformed lines and unsorted timestamps', () => {
    const good = [meta(T0 + 1000, 'https://x.test/'), fullSnapshot(T0, [el(10, 'button', {}, [txt(11, 'Go')])]), click(T0 + 2000, 10)];
    const ndjson = 'NOT JSON\n' + JSON.stringify(good[2]) + '\n{broken\n' + JSON.stringify(good[0]) + '\n' + JSON.stringify(good[1]) + '\n';
    const d = extractDigest(ndjson);
    expect(d.steps.filter((s) => s.kind === 'click')).toHaveLength(1);
  });

  it('degrades without a full snapshot: navs survive, clicks get tag fallback', () => {
    const d = extractDigest(ndjsonOf([meta(T0, 'https://x.test/'), click(T0 + 100, 99)]));
    expect(d.steps.filter((s) => s.kind === 'nav')).toHaveLength(1);
    expect(d.steps.filter((s) => s.kind === 'click')[0]).toMatchObject({ label: '<unknown>' });
  });

  it('elides the middle beyond 60 steps', () => {
    const events: unknown[] = [meta(T0, 'https://x.test/'), fullSnapshot(T0, [el(10, 'button', {}, [txt(11, 'Go')])])];
    for (let i = 0; i < 200; i++) events.push(click(T0 + 1000 + i * 1000, 10));
    const d = extractDigest(ndjsonOf(events));
    expect(d.steps.length).toBeLessThanOrEqual(60);
    expect(d.stats.clickCount).toBe(200);
  });

  it('exports DIGEST_VERSION', () => {
    expect(DIGEST_VERSION).toBe(2);
  });

  it('captures the viewport from the first meta event', () => {
    const d = extractDigest(ndjsonOf([
      { type: 4, timestamp: T0, data: { href: 'https://x.test/', width: 390, height: 844 } },
      fullSnapshot(T0, []),
    ]));
    expect(d.stats.viewport).toBe('390x844');
  });
});

describe('insights', () => {
  it('detects rage clicks: ≥3 clicks within 700ms gaps and 30px radius', () => {
    const d = extractDigest(ndjsonOf([
      meta(T0, 'https://x.test/'), fullSnapshot(T0, [el(10, 'button', {}, [txt(11, 'Go')])]),
      click(T0, 10, 100, 100), click(T0 + 300, 10, 105, 102), click(T0 + 600, 10, 103, 99),
    ]));
    expect(d.insights).toContainEqual(expect.objectContaining({ kind: 'rage_click', count: 3, detail: 'Go' }));
  });

  it('does not flag 3 slow clicks as rage', () => {
    const d = extractDigest(ndjsonOf([
      meta(T0, 'https://x.test/'), fullSnapshot(T0, [el(10, 'button', {}, [txt(11, 'Go')])]),
      click(T0, 10), click(T0 + 2000, 10), click(T0 + 4000, 10),
    ]));
    expect(d.insights.filter((i) => i.kind === 'rage_click')).toHaveLength(0);
  });

  it('detects dead clicks (no mutation/nav/input within 1s), sparing session-final clicks', () => {
    const d = extractDigest(ndjsonOf([
      meta(T0, 'https://x.test/'), fullSnapshot(T0, [el(10, 'button', {}, [txt(11, 'Broken')]), el(20, 'button', {}, [txt(21, 'Works')])]),
      click(T0 + 1000, 10),                       // dead: next effect is 5s away
      mutationAdd(T0 + 6000, 3, el(40, 'div')),
      click(T0 + 7000, 20),                       // alive: mutation 200ms later
      mutationAdd(T0 + 7200, 3, el(41, 'div')),
      click(T0 + 9000, 10),                       // last click <1s before end — spared
    ]));
    const dead = d.insights.filter((i) => i.kind === 'dead_click');
    expect(dead).toEqual([expect.objectContaining({ kind: 'dead_click', at: T0 + 1000, detail: 'Broken' })]);
  });

  it('detects nav U-turns and pogo-sticking', () => {
    const nav = (t: number, href: string) => ({ type: 5, timestamp: t, data: { tag: 'mega-url-change', payload: { href } } });
    const d = extractDigest(ndjsonOf([
      meta(T0, 'https://x.test/a'), fullSnapshot(T0, []),
      nav(T0 + 2000, 'https://x.test/b'), nav(T0 + 4000, 'https://x.test/a'),
      nav(T0 + 6000, 'https://x.test/b'), nav(T0 + 8000, 'https://x.test/a'),
    ]));
    expect(d.insights.filter((i) => i.kind === 'uturn').length).toBeGreaterThanOrEqual(1);
    // a→b→a→b→a yields 3 A|B round-trip detections (one per uturn window)
    expect(d.insights).toContainEqual(expect.objectContaining({ kind: 'pogo_stick', count: 3 }));
  });

  it('detects refresh loops (2+ meta loads of same URL within 30s)', () => {
    const d = extractDigest(ndjsonOf([
      meta(T0, 'https://x.test/checkout'), fullSnapshot(T0, []),
      meta(T0 + 5000, 'https://x.test/checkout'), fullSnapshot(T0 + 5000, []),
      meta(T0 + 9000, 'https://x.test/checkout'), fullSnapshot(T0 + 9000, []),
    ]));
    expect(d.insights).toContainEqual(expect.objectContaining({ kind: 'refresh_loop', count: 3 }));
  });

  it('flags form abandonment with the last touched field; a submit-like click clears it', () => {
    const abandoned = extractDigest(ndjsonOf([
      meta(T0, 'https://x.test/signup'),
      fullSnapshot(T0, [el(10, 'input', { placeholder: 'Email' }), el(20, 'input', { placeholder: 'Password' })]),
      input(T0 + 1000, 10), input(T0 + 5000, 20),
    ]));
    expect(abandoned.insights).toContainEqual(expect.objectContaining({ kind: 'form_abandon', detail: 'Password' }));

    const submitted = extractDigest(ndjsonOf([
      meta(T0, 'https://x.test/signup'),
      fullSnapshot(T0, [el(10, 'input', { placeholder: 'Email' }), el(30, 'button', { type: 'submit' }, [txt(31, 'Create account')])]),
      input(T0 + 1000, 10), click(T0 + 2000, 30),
    ]));
    expect(submitted.insights.filter((i) => i.kind === 'form_abandon')).toHaveLength(0);
  });
});

describe('compactDigest', () => {
  it('renders a token-lean text log: relative times, paths, signals, no JSON keys or raw timestamps', async () => {
    const { compactDigest } = await import('./session-digest');
    const d = extractDigest(ndjsonOf([
      meta(T0, 'https://x.test/signup'),
      fullSnapshot(T0, [el(10, 'input', { placeholder: 'Email' }), el(20, 'button', {}, [txt(21, 'Pricing')])]),
      click(T0 + 5000, 20),
      input(T0 + 9000, 10),
    ]));
    const c = compactDigest(d);
    expect(c).toContain('steps:');
    expect(c).toContain('0:05 click "Pricing"');
    expect(c).toContain('0:09 typed-in Email');
    expect(c).toContain('nav x.test/signup');
    expect(c).toContain('signals: ');
    expect(c).toContain('form_abandon (Email)');
    expect(c).not.toContain('"kind"');
    expect(c).not.toMatch(/\d{13}/); // no epoch timestamps
    // Smaller than the raw JSON it replaces even for a tiny session;
    // the per-step savings compound on realistic ones.
    expect(c.length).toBeLessThan(JSON.stringify(d).length / 2);
  });

  it('falls back to JSON for digests without steps', async () => {
    const { compactDigest } = await import('./session-digest');
    expect(compactDigest({ marker: 'X' })).toBe('{"marker":"X"}');
  });

  it('renders the session context line when attached', async () => {
    const { compactDigest } = await import('./session-digest');
    const d = extractDigest(ndjsonOf([
      { type: 4, timestamp: T0, data: { href: 'https://x.test/pricing?utm_source=li', width: 1440, height: 900 } },
      fullSnapshot(T0, [el(10, 'button', {}, [txt(11, 'Go')])]),
      click(T0 + 1000, 10),
    ]));
    d.context = { entryUrl: 'https://x.test/pricing?utm_source=li', referrer: 'https://www.linkedin.com/', country: 'IL', browser: 'Chrome', os: 'Windows' };
    const c = compactDigest(d);
    expect(c).toContain('context: entry https://x.test/pricing?utm_source=li; from https://www.linkedin.com/; Chrome on Windows; IL; viewport 1440x900');
  });
});

describe('renderNarrative', () => {
  it('renders one line per step with m:ss offsets', async () => {
    const { renderNarrative } = await import('./session-digest');
    const d = extractDigest(ndjsonOf([
      meta(T0, 'https://x.test/home'),
      fullSnapshot(T0, [el(10, 'button', {}, [txt(11, 'Pricing')])]),
      click(T0 + 65_000, 10),
    ]));
    const n = renderNarrative(d);
    expect(n).toContain('0:00 Landed on https://x.test/home');
    expect(n).toContain('1:05 Clicked "Pricing"');
  });
});
