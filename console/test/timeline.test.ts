import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildTimeline, duration, endpointName, percentiles } from '../lib/timeline.ts';

const nimbus = {
  detector: 'consumer_stalled', summary: 'Queue backlog is aging', openedAt: '2026-11-18T23:41:18.000Z', recoveredAt: '2026-11-18T23:41:19.056Z',
  evidence: { windowEndedAt: '2026-11-18T23:30:00Z', visibleMessages: 200, oldestMessageSeconds: 600, lambdaInvocations: 0 },
};

test('merges the four products into one ordered timeline', () => {
  const events = buildTimeline({
    nimbus,
    audit: [{ flag: 'orders-v2', entries: [
      { actor: 'nimbus (automation)', action: 'rolled back to #45', createdAt: '2026-11-18T23:41:19.726Z' },
      { actor: 'nimbus (automation)', action: 'killed by nimbus incident fdd2: x', createdAt: '2026-11-18T23:41:18.700Z' },
      { actor: 'atalaya-demo', action: 'turned on', createdAt: '2026-11-18T22:00:00.000Z' }, // long before: not this incident
    ] }],
    messages: [{ eventType: 'incident.opened', deliveries: [
      { endpointUrl: 'http://toxiproxy:14100/oncall', attempts: [{ statusCode: 200, durationMs: 34, error: null, createdAt: '2026-11-18T23:41:18.900Z' }] },
      { endpointUrl: 'http://toxiproxy:18090/webhooks/hookrelay/abc', attempts: [{ statusCode: null, durationMs: null, error: 'ECONNREFUSED', createdAt: '2026-11-18T23:41:18.950Z' }] },
    ] }],
    ledger: { restoredAt: '2026-11-18T23:41:19.726Z' },
  });
  assert.deepEqual(events.map((e) => `${e.product}:${e.title}`), [
    'nimbus:Degraded window closed',
    'nimbus:Incident opened · consumer_stalled',
    'flagship:orders-v2 turned OFF (kill switch)',
    'hookrelay:incident.opened → On-call',
    'hookrelay:incident.opened → Bitácora',
    'nimbus:Incident recovered',
    'flagship:orders-v2 restored',
  ]);
  assert.equal(events[4].tone, 'warn');
  assert.match(events[4].detail!, /ECONNREFUSED · retried/);
});

test('labels the outcome of each delivery attempt', () => {
  const at = (s: number) => new Date(Date.UTC(2026, 10, 18, 23, 0, s)).toISOString();
  const attempt = (s: number, ok: boolean) => ({ statusCode: ok ? 200 : null, durationMs: ok ? 5 : null, error: ok ? null : 'ECONNREFUSED', createdAt: at(s) });
  const events = buildTimeline({ messages: [
    { eventType: 'incident.opened', deliveries: [{ endpointUrl: 'http://x/oncall', status: 'succeeded', attempts: [attempt(1, false), attempt(3, false), attempt(30, true)] }] },
    { eventType: 'incident.recovered', deliveries: [{ endpointUrl: 'http://x/oncall', status: 'failed', attempts: [attempt(5, false), attempt(7, false)] }] },
  ] });
  assert.deepEqual(events.map((e) => e.detail), [
    'failed: ECONNREFUSED · retried', 'failed: ECONNREFUSED · retried', 'failed: ECONNREFUSED · retried',
    'failed: ECONNREFUSED · parked in the DLQ', '200 in 5 ms · after 2 failed attempts',
  ]);
  assert.equal(events[3].tone, 'bad');
});

test('helpers', () => {
  assert.equal(endpointName('http://toxiproxy:14100/oncall'), 'On-call');
  assert.equal(endpointName('https://hooks.acme.com/in'), 'hooks.acme.com');
  assert.deepEqual(percentiles([900, 600, 700, 16000]), { p50: 700, p95: 16000 });
  assert.deepEqual(percentiles([]), {});
  assert.deepEqual([duration(677), duration(16151), duration(125_000), duration(undefined)], ['677 ms', '16.2 s', '2 min 5 s', '—']);
});

test('shows an escalation when automation could not mitigate', () => {
  const events = buildTimeline({ nimbus: { detector: 'consumer_stalled', summary: 's', openedAt: '2026-11-18T10:00:00.000Z', escalatedAt: '2026-11-18T10:01:30.000Z' } });
  assert.deepEqual(events.map((e) => [e.title, e.tone]), [['Incident opened · consumer_stalled', 'bad'], ['Mitigation failed · escalated to on-call', 'bad']]);
});
