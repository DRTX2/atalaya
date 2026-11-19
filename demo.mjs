// End-to-end Atalaya scenario, asserted step by step:
//   Nimbus detects a stalled pipeline -> Flagship kills the risky feature flag (SDK sees it in ms)
//   -> Hookrelay delivers the incident to a customer webhook. Recovery restores the flag.
//   -> Bitácora, subscribed through Hookrelay, rebuilds the timeline and drafts the postmortem.
// usage: docker compose up -d --wait && node demo.mjs      (Node 24+, no dependencies)
// Failure behaviour is exercised separately by the game days: node chaos/run.mjs
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { bitacora, bitacoraText, deliveries, flagAudit, platform, prepareScenario, until } from './lib/atalaya.mjs';

const step = (n, text) => console.log(`\n${n}. ${text}`);
const ok = (text) => console.log(`   ✓ ${text}`);
const delivered = async (p, incidentId, endpointId, eventType) =>
  (await deliveries(p, incidentId)).some((d) => d.endpointId === endpointId && d.eventType === eventType && d.status === 'succeeded');

step(1, 'Hookrelay: the platform tenant (bootstrap) + a customer endpoint subscribed to incident events');
const p = await platform();
const runStartedAt = new Date().toISOString();
ok(`tenant ${p.hookrelayAppId} (endpoints: on-call receiver, Bitácora)`);

step(2, 'Flagship: a risky feature flag, ON in production, with an SDK stream connected');
step(3, 'Nimbus: response + recovery workflows that call Flagship and Hookrelay (HMAC-signed HTTP steps)');
const s = await prepareScenario(p, 'demo');
ok(`${s.flagKey} is ON and the SDK sees it`);
ok(`pipeline ${s.pipeline.id} watched (fixture mode: no AWS account needed)`);

step(4, 'The consumer stalls: two degraded windows (backlog 200, oldest message 10 min, 0 invocations)');
await s.stall();
const incident = await s.waitIncident();
ok(`Nimbus opened incident ${incident.id} (${incident.detector})`);
await until('flag killed in the SDK', async () => s.sdk.on === false);
ok(`Flagship turned ${s.flagKey} OFF; the SDK saw it ${s.sdk.changes.at(-1).at - s.stalledAt} ms after the observation`);
const audit = await flagAudit(s.flagKey);
assert.match(audit[0].action, /^killed by nimbus incident/);
ok(`audit: "${audit[0].actor}" ${audit[0].action}`);
await until('customer webhook for incident.opened', () => delivered(p, incident.id, p.oncallEndpointId, 'incident.opened'));
ok('Hookrelay delivered incident.opened to the customer endpoint (signed, with retries/DLQ behind it)');

step(5, 'The consumer recovers: two healthy windows');
await s.recover();
await until('flag restored in the SDK', async () => s.sdk.on === true);
ok(`Flagship restored ${s.flagKey} to its pre-incident configuration`);
await until('customer webhook for incident.recovered', () => delivered(p, incident.id, p.oncallEndpointId, 'incident.recovered'));
ok('Hookrelay delivered incident.recovered');

step(6, 'Bitácora rebuilt the incident from the webhooks Hookrelay delivered to it');
const ledger = await until('Bitácora timeline complete', async () => {
  const r = await bitacora('GET', `/incidents/${incident.id}`);
  return r.metrics.status === 'recovered' && r.timeline.some((t) => t.type === 'flag.restored') ? r : undefined;
});
assert.deepEqual(ledger.timeline.map((t) => t.type), ['incident.opened', 'flag.killed', 'incident.recovered', 'flag.restored']);
assert.deepEqual(ledger.incident.flags, [`${s.flagKey}@production`]);
ok(`timeline: ${ledger.timeline.map((t) => t.type).join(' -> ')}`);
ok(`metrics: mitigated in ${ledger.metrics.timeToMitigateMs} ms, recovered in ${(ledger.metrics.timeToRecoverMs / 1000).toFixed(1)} s, flag restored ${ledger.metrics.timeToRestoreMs} ms after recovery`);
const postmortem = await bitacoraText(`/incidents/${incident.id}/postmortem`);
assert.match(postmortem, /## Timeline/);
writeFileSync('docs/postmortem-example.md', postmortem);
ok('postmortem drafted (saved to docs/postmortem-example.md)');

step(7, 'Evidence kept by each product');
const messages = await p.hr('GET', '/v1/messages?limit=50');
const thisRun = messages.data.filter((m) => m.createdAt >= runStartedAt);
console.log('   Hookrelay messages:', thisRun.map((m) => `${m.eventType} (${m.succeeded}/${m.fanout} delivered)`).reverse().join(', '));
console.log('   Flagship audit:   ', (await flagAudit(s.flagKey)).map((a) => a.action.split(':')[0].replace(/ [0-9a-f-]{36}/, '')).reverse().join(' -> '));

writeFileSync('.demo-state.json', JSON.stringify({ hookrelayApiKey: p.hookrelayApiKey, flagKey: s.flagKey, incidentId: incident.id, pipelineId: s.pipeline.id, messageId: thisRun.at(-1)?.id }, null, 2)); // handy for exploring the dashboards afterwards
s.close();
console.log('\nAll assertions passed.');
process.exit(0);
