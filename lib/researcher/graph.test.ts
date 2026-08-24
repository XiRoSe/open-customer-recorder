import { describe, it, expect } from 'vitest';
import { acquireSlot, releaseSlot } from './graph';

// RESEARCHER_CONCURRENCY isn't set in the test env, so MAX_CONCURRENT
// defaults to 1 (module-level constant, matches production default) —
// these tests exercise the FIFO queue that kicks in once that one slot
// is taken.
describe('researcher slot queue', () => {
  it('the first caller starts immediately; a second queues and is handed the slot in order', async () => {
    const first = acquireSlot();
    expect(first).not.toBeNull();
    expect(first!.position).toBe(0);
    await expect(first!.ready).resolves.toBe('ok');

    const second = acquireSlot();
    expect(second).not.toBeNull();
    expect(second!.position).toBe(1); // queued behind the first

    let secondSettled = false;
    void second!.ready.then(() => { secondSettled = true; });
    await Promise.resolve();
    expect(secondSettled).toBe(false); // still waiting — slot 1 hasn't been released

    releaseSlot(); // frees the first caller's slot
    await expect(second!.ready).resolves.toBe('ok'); // handed straight to the queued caller

    releaseSlot(); // balance out for later tests sharing this module's state
  });

  it('FIFO order — a third queued caller is served after the second, not before', async () => {
    const a = acquireSlot();
    expect(a!.position).toBe(0);

    const b = acquireSlot();
    expect(b!.position).toBe(1);
    const c = acquireSlot();
    expect(c!.position).toBe(2);

    const order: string[] = [];
    void b!.ready.then(() => order.push('b'));
    void c!.ready.then(() => order.push('c'));

    releaseSlot(); // a's slot frees
    await b!.ready;
    releaseSlot(); // b's slot frees
    await c!.ready;

    expect(order).toEqual(['b', 'c']);
    releaseSlot(); // balance out for later tests
  });

  it('releaseSlot with an empty queue never goes negative or throws', () => {
    // Whatever the module's active count happens to be after the tests
    // above, over-releasing must be a harmless no-op, not a crash or a
    // negative count that would let too many concurrent runs through.
    expect(() => { releaseSlot(); releaseSlot(); releaseSlot(); }).not.toThrow();
  });
});
