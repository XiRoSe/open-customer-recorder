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
    expect(DIGEST_VERSION).toBe(1);
  });
});
