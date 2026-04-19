// @vitest-environment happy-dom
/**
 * L2.1 — SSE client (`src/lib/sse.ts`).
 *
 * The browser-side subscriber wraps `EventSource` so React code can call
 * `subscribe(onEvent)` without caring about reconnects. Contract:
 *
 *   1. `subscribe(cb)` returns an unsubscribe function; calling it closes the
 *      underlying EventSource and stops any pending reconnect timer.
 *   2. When the server pushes `event: foo\ndata: {...}`, the callback is
 *      invoked with (`'foo'`, parsed-JSON-object).
 *   3. If the EventSource fires `error` (connection drop), the client
 *      reconnects with exponential backoff: 1s, 2s, 4s, 8s, 16s, then capped
 *      at 30s.
 *   4. A successful reopen resets the backoff schedule back to 1s.
 *
 * Tests use a mutable global `EventSource` mock so we can drive open/message/
 * error manually and fake-timer the reconnect intervals.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Listener = (ev: MessageEvent | Event) => void;

class MockEventSource {
  static instances: MockEventSource[] = [];
  static lastInstance(): MockEventSource {
    const last = MockEventSource.instances[MockEventSource.instances.length - 1];
    if (!last) throw new Error('no MockEventSource yet');
    return last;
  }

  url: string;
  readyState = 0;
  closed = false;
  private listeners: Map<string, Set<Listener>> = new Map();
  onerror: ((e: Event) => void) | null = null;
  onopen: ((e: Event) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, cb: Listener): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(cb);
  }

  removeEventListener(type: string, cb: Listener): void {
    this.listeners.get(type)?.delete(cb);
  }

  close(): void {
    this.closed = true;
    this.readyState = 2;
  }

  /** Test helper: dispatch a named SSE event. */
  emit(type: string, data: unknown): void {
    const ev = new MessageEvent(type, { data: JSON.stringify(data) });
    this.listeners.get(type)?.forEach((cb) => cb(ev));
  }

  /** Test helper: simulate connection opened. */
  open(): void {
    this.readyState = 1;
    this.onopen?.(new Event('open'));
  }

  /** Test helper: simulate connection error/drop. */
  error(): void {
    this.readyState = 2;
    this.onerror?.(new Event('error'));
  }
}

// Install the mock before importing the module under test so the module's
// lexical reference to EventSource picks up our fake.
beforeEach(() => {
  MockEventSource.instances = [];
  (globalThis as unknown as { EventSource: typeof MockEventSource }).EventSource =
    MockEventSource;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  // Scrub module cache so each test gets a fresh import (in case the client
  // uses module-level state).
  vi.resetModules();
});

describe('subscribe() — L2.1 SSE client', () => {
  it('opens an EventSource against /api/events/stream', async () => {
    const { subscribe } = await import('../../src/lib/sse');
    const cb = vi.fn();
    const unsub = subscribe(cb);
    expect(MockEventSource.instances.length).toBe(1);
    expect(MockEventSource.lastInstance().url).toBe('/api/events/stream');
    unsub();
  });

  it('forwards named events with parsed JSON payload to the callback', async () => {
    const { subscribe } = await import('../../src/lib/sse');
    const cb = vi.fn();
    const unsub = subscribe(cb);
    const es = MockEventSource.lastInstance();

    es.emit('session:new', { sessionId: 'abc', file: '/tmp/x.jsonl' });
    es.emit('span:new', { sessionId: 'abc', spanDelta: 2 });

    expect(cb).toHaveBeenNthCalledWith(1, 'session:new', {
      sessionId: 'abc',
      file: '/tmp/x.jsonl',
    });
    expect(cb).toHaveBeenNthCalledWith(2, 'span:new', {
      sessionId: 'abc',
      spanDelta: 2,
    });
    unsub();
  });

  it('subscribes to all four live-mode event names', async () => {
    const { subscribe } = await import('../../src/lib/sse');
    const cb = vi.fn();
    const unsub = subscribe(cb);
    const es = MockEventSource.lastInstance();

    es.emit('session:new', { sessionId: 's1' });
    es.emit('span:new', { sessionId: 's1' });
    es.emit('marker:opened', { sessionId: 's1', label: 'hi' });
    es.emit('marker:closed', { sessionId: 's1' });

    expect(cb).toHaveBeenCalledTimes(4);
    unsub();
  });

  it('unsubscribe() closes the EventSource', async () => {
    const { subscribe } = await import('../../src/lib/sse');
    const unsub = subscribe(vi.fn());
    const es = MockEventSource.lastInstance();
    expect(es.closed).toBe(false);
    unsub();
    expect(es.closed).toBe(true);
  });

  it('reconnects with exponential backoff: 1s, 2s, 4s, 8s, capped at 30s', async () => {
    const { subscribe } = await import('../../src/lib/sse');
    const unsub = subscribe(vi.fn());

    // First instance errors → wait 1s → reopen
    MockEventSource.lastInstance().error();
    expect(MockEventSource.instances.length).toBe(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(MockEventSource.instances.length).toBe(1);
    await vi.advanceTimersByTimeAsync(2);
    expect(MockEventSource.instances.length).toBe(2);

    // Second errors → wait 2s → reopen
    MockEventSource.lastInstance().error();
    await vi.advanceTimersByTimeAsync(1999);
    expect(MockEventSource.instances.length).toBe(2);
    await vi.advanceTimersByTimeAsync(2);
    expect(MockEventSource.instances.length).toBe(3);

    // Third errors → 4s
    MockEventSource.lastInstance().error();
    await vi.advanceTimersByTimeAsync(4001);
    expect(MockEventSource.instances.length).toBe(4);

    // Fourth → 8s
    MockEventSource.lastInstance().error();
    await vi.advanceTimersByTimeAsync(8001);
    expect(MockEventSource.instances.length).toBe(5);

    // Fifth → 16s
    MockEventSource.lastInstance().error();
    await vi.advanceTimersByTimeAsync(16001);
    expect(MockEventSource.instances.length).toBe(6);

    // Sixth → capped at 30s (not 32s)
    MockEventSource.lastInstance().error();
    await vi.advanceTimersByTimeAsync(29999);
    expect(MockEventSource.instances.length).toBe(6);
    await vi.advanceTimersByTimeAsync(2);
    expect(MockEventSource.instances.length).toBe(7);

    // Seventh also capped at 30s
    MockEventSource.lastInstance().error();
    await vi.advanceTimersByTimeAsync(30001);
    expect(MockEventSource.instances.length).toBe(8);

    unsub();
  });

  it('resets backoff after a successful reopen', async () => {
    const { subscribe } = await import('../../src/lib/sse');
    const unsub = subscribe(vi.fn());

    // Error → 1s reconnect
    MockEventSource.lastInstance().error();
    await vi.advanceTimersByTimeAsync(1001);
    expect(MockEventSource.instances.length).toBe(2);

    // Error again → 2s
    MockEventSource.lastInstance().error();
    await vi.advanceTimersByTimeAsync(2001);
    expect(MockEventSource.instances.length).toBe(3);

    // Mark this one open successfully → backoff should reset
    MockEventSource.lastInstance().open();

    // Now error again → should go back to 1s, not 4s
    MockEventSource.lastInstance().error();
    await vi.advanceTimersByTimeAsync(1001);
    expect(MockEventSource.instances.length).toBe(4);

    unsub();
  });

  it('unsubscribe during backoff wait cancels the pending reconnect', async () => {
    const { subscribe } = await import('../../src/lib/sse');
    const unsub = subscribe(vi.fn());
    MockEventSource.lastInstance().error();
    // Halfway through the 1s wait, unsubscribe.
    await vi.advanceTimersByTimeAsync(500);
    unsub();
    // Advance well past when the reconnect would have fired.
    await vi.advanceTimersByTimeAsync(5000);
    expect(MockEventSource.instances.length).toBe(1);
  });

  it('malformed data: does not crash, does not invoke the callback for that frame', async () => {
    const { subscribe } = await import('../../src/lib/sse');
    const cb = vi.fn();
    const unsub = subscribe(cb);
    const es = MockEventSource.lastInstance();

    // Simulate a data frame that isn't valid JSON.
    const ev = new MessageEvent('span:new', { data: '{not-json' });
    // Fire via the private listener path — we need the dispatch to reach the
    // subscriber's wrapper. Use addEventListener's stored listener.
    // @ts-expect-error — reach into test-only `listeners` field.
    es.listeners.get('span:new')?.forEach((h: Listener) => h(ev));

    expect(cb).not.toHaveBeenCalled();

    // And a well-formed one afterwards still flows.
    es.emit('span:new', { sessionId: 'ok' });
    expect(cb).toHaveBeenCalledWith('span:new', { sessionId: 'ok' });
    unsub();
  });
});
