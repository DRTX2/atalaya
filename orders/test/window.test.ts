import assert from 'node:assert/strict';
import { test } from 'node:test';
import { backlogSince, counterDelta, observe, windowStart } from '../src/window.ts';

const T0 = Date.UTC(2026, 10, 18, 12, 0, 0);

test('windows align to UTC multiples of the window', () => {
  assert.equal(windowStart(T0 + 29_999, 30_000), T0);
  assert.equal(windowStart(T0 + 30_000, 30_000), T0 + 30_000);
});

test('oldest message age is how long the queue has continuously held messages', () => {
  let since: number | null = null;
  since = backlogSince(since, { at: T0, visible: 5, inFlight: 0, dlq: 0 });
  since = backlogSince(since, { at: T0 + 5_000, visible: 40, inFlight: 0, dlq: 0 });
  assert.equal(since, T0);
  assert.equal(backlogSince(since, { at: T0 + 10_000, visible: 0, inFlight: 0, dlq: 0 }), null, 'a drained queue resets the age');
});

test('a stalled consumer produces the signal Nimbus looks for', () => {
  const samples = [0, 5, 10, 15, 20, 25].map((s) => ({ at: T0 + s * 1000, visible: 50 + s * 10, inFlight: 0, dlq: 0 }));
  const o = observe(T0, 30_000, samples, T0 - 15_000, counterDelta(7, 7), counterDelta(0, 0));
  assert.deepEqual(o, {
    windowStartedAt: '2026-11-18T12:00:00.000Z', windowEndedAt: '2026-11-18T12:00:30.000Z',
    visibleMessages: 300, inFlightMessages: 0, dlqMessages: 0, oldestMessageSeconds: 45,
    lambdaInvocations: 0, lambdaErrors: 0, lambdaThrottles: 0,
  });
});

test('a consumer restart resets its counters: the delta counts from zero', () => {
  assert.equal(counterDelta(120, 100), 20);
  assert.equal(counterDelta(4, 100), 4);
});
