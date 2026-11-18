// End-to-end Atalaya scenario, asserted step by step:
//   Nimbus detects a stalled pipeline -> Flagship kills the risky feature flag (SDK sees it in ms)
//   -> Hookrelay delivers the incident to a customer webhook. Recovery restores the flag.
//   -> Bitácora, subscribed through Hookrelay, rebuilds the timeline and drafts the postmortem.
// usage: docker compose up -d --wait && node demo.mjs      (Node 24+, no dependencies)
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const HOOKRELAY = 'http://localhost:3000', FLAGSHIP = 'http://localhost:4000', NIMBUS = 'http://localhost:8080', BITACORA = 'http://localhost:8090';
const ADMIN = process.env.ADMIN_TOKEN ?? 'change-me';
const NIMBUS_KEY = process.env.NIMBUS_API_KEY ?? 'nimbus-local-development-key';
const run = Date.now().toString(36);
const step = (n, text) => console.log(`\n${n}. ${text}`);
const ok = (text) => console.log(`   ✓ ${text}`);

async function http(base, method, path, { body, headers } = {}) {
  const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...headers }, body: body && JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${base}${path} -> ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}
const hookrelayAdmin = (m, p, body) => http(HOOKRELAY, m, p, { body, headers: { 'x-admin-token': ADMIN } });
const flagship = (m, p, body) => http(FLAGSHIP, m, p, { body, headers: { authorization: `Bearer ${ADMIN}`, 'x-actor': 'atalaya-demo' } });
const bitacora = (m, p) => http(BITACORA, m, p, { headers: { authorization: `Bearer ${ADMIN}` } });
const nimbus = (m, p, body, extra = {}) => http(NIMBUS, m, p, { body, headers: { authorization: `Bearer ${NIMBUS_KEY}`, ...extra } });
async function until(what, fn, timeoutMs = 60_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn().catch(() => undefined);
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

step(1, 'Hookrelay: the platform tenant (bootstrap) + a customer endpoint subscribed to incident events');
// bootstrap.mjs created the tenant, gave Flagship its key and subscribed Bitácora to incident.* and flag.*
const platform = JSON.parse(execSync('docker compose run --rm --no-deps -T --entrypoint cat bootstrap /state/platform.json', { encoding: 'utf8' }));
const app = { id: platform.hookrelayAppId, apiKey: platform.hookrelayApiKey };
const hr = (m, p, body) => http(HOOKRELAY, m, p, { body, headers: { authorization: `Bearer ${app.apiKey}` } });
if (!(await hr('GET', '/v1/endpoints')).some((e) => e.url === 'http://receiver:4000/oncall')) {
  await hr('POST', '/v1/endpoints', { url: 'http://receiver:4000/oncall', eventTypes: ['incident.opened', 'incident.recovered'], description: 'On-call system' });
}
const runStartedAt = new Date().toISOString();
ok(`tenant ${app.id} (endpoints: on-call receiver, Bitácora)`);

step(2, 'Flagship: a risky feature flag, ON in production, with an SDK stream connected');
const flagKey = `orders-v2-${run}`;
await flagship('POST', '/api/flags', { key: flagKey, name: 'Orders v2 pipeline', kind: 'boolean', variations: [false, true] });
const created = await flagship('GET', `/api/flags/${flagKey}`);
await flagship('PUT', `/api/flags/${flagKey}/envs/production`, { enabled: true, offVariation: 0, fallthrough: { variation: 1 }, rules: [], version: created.envs.production.version });
const { sdkKey } = await flagship('POST', '/api/environments/production/sdk-key');
// Minimal SDK: follow the stream and keep the flag's state (the real SDK does this plus local evaluation).
let flagOn, flagChangedAt;
const stream = await fetch(`${FLAGSHIP}/sdk/v1/stream`, { headers: { authorization: `Bearer ${sdkKey}` } });
(async () => {
  const dec = new TextDecoder(); let buf = '';
  for await (const chunk of stream.body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) !== -1) {
      const frame = buf.slice(0, i); buf = buf.slice(i + 2);
      const data = frame.split('\n').find((l) => l.startsWith('data:'))?.slice(5);
      if (!data) continue;
      const msg = JSON.parse(data);
      const flag = msg.flags?.[flagKey] ?? (msg.flag?.key === flagKey ? msg.flag : null);
      if (flag) { flagOn = flag.enabled; flagChangedAt = performance.now(); }
    }
  }
})().catch(() => {});
await until('SDK initial ruleset', async () => flagOn === true);
ok(`${flagKey} is ON and the SDK sees it`);

step(3, 'Nimbus: response + recovery workflows that call Flagship and Hookrelay (HMAC-signed HTTP steps)');
const workflow = (name, eventType) => nimbus('POST', '/v1/workflows', {
  name: `${name} ${run}`,
  definition: {
    schemaVersion: 1, eventType,
    steps: [
      { id: 'flag', type: 'http', http: { method: 'POST', url: `http://flagship:4000/automation/nimbus/flags/${flagKey}/envs/production`, bodyMode: 'event' } },
      { id: 'notify', type: 'http', http: { method: 'POST', url: `http://hookrelay-api:3000/v1/inbound/nimbus/${app.id}`, bodyMode: 'event' } },
    ],
  },
});
const opened = await workflow('Kill switch + notify', 'nimbus.incident.opened');
const recovered = await workflow('Restore + notify', 'nimbus.incident.recovered');
const pipeline = await nimbus('POST', '/v1/pipelines', {
  name: `Orders async pipeline ${run}`, mode: 'fixture', region: 'us-east-1',
  queueArn: `arn:aws:sqs:us-east-1:123456789012:orders-${run}`, lambdaArn: `arn:aws:lambda:us-east-1:123456789012:function:orders-consumer-${run}`, // unique per run so the demo is repeatable
  dlqArn: `arn:aws:sqs:us-east-1:123456789012:orders-dlq-${run}`,
  incidentWorkflowId: opened.id, recoveryWorkflowId: recovered.id, consecutiveWindows: 2, backlogThreshold: 100, ageThresholdSeconds: 300,
});
ok(`pipeline ${pipeline.id} watched (fixture mode: no AWS account needed)`);

const base = Math.floor(Date.now() / 300_000) * 300_000 - 4 * 300_000; // four closed 5-minute windows
const observe = (n, metrics) => nimbus('POST', `/v1/pipelines/${pipeline.id}/observations`, {
  windowStartedAt: new Date(base + n * 300_000).toISOString(), windowEndedAt: new Date(base + (n + 1) * 300_000).toISOString(),
  inFlightMessages: 0, oldestMessageSeconds: 0, dlqMessages: 0, lambdaErrors: 0, lambdaThrottles: 0, ...metrics,
});
const receiverLog = () => execSync('docker compose logs receiver --no-log-prefix', { encoding: 'utf8' });

step(4, 'The consumer stalls: two degraded windows (backlog 200, oldest message 10 min, 0 invocations)');
const stalled = { visibleMessages: 200, oldestMessageSeconds: 600, lambdaInvocations: 0 };
await observe(0, stalled);
const t0 = performance.now();
await observe(1, stalled);
const incident = await until('incident opened', async () => (await nimbus('GET', '/v1/incidents')).items?.find((i) => i.pipelineId === pipeline.id && i.status !== 'recovered'));
ok(`Nimbus opened incident ${incident.id} (${incident.detector})`);
await until('flag killed in the SDK', async () => flagOn === false);
ok(`Flagship turned ${flagKey} OFF; the SDK saw it ${Math.round(flagChangedAt - t0)} ms after the observation`);
const audit = await flagship('GET', `/api/flags/${flagKey}/audit`);
assert.match(audit[0].action, /^killed by nimbus incident/);
ok(`audit: "${audit[0].actor}" ${audit[0].action}`);
await until('customer webhook for incident.opened', async () => receiverLog().includes('incident.opened'));
ok('Hookrelay delivered incident.opened to the customer endpoint (signed, with retries/DLQ behind it)');

step(5, 'The consumer recovers: two healthy windows');
const healthy = { visibleMessages: 3, lambdaInvocations: 250 };
await observe(2, healthy);
await observe(3, healthy);
await until('flag restored in the SDK', async () => flagOn === true);
ok(`Flagship restored ${flagKey} to its pre-incident configuration`);
await until('customer webhook for incident.recovered', async () => receiverLog().includes('incident.recovered'));
ok('Hookrelay delivered incident.recovered');

step(6, 'Bitácora rebuilt the incident from the webhooks Hookrelay delivered to it');
const ledger = await until('Bitácora timeline complete', async () => {
  const r = await bitacora('GET', `/incidents/${incident.id}`);
  return r.metrics.status === 'recovered' && r.timeline.some((t) => t.type === 'flag.restored') ? r : undefined;
});
assert.deepEqual(ledger.timeline.map((t) => t.type), ['incident.opened', 'flag.killed', 'incident.recovered', 'flag.restored']);
assert.deepEqual(ledger.incident.flags, [`${flagKey}@production`]);
ok(`timeline: ${ledger.timeline.map((t) => t.type).join(' -> ')}`);
ok(`metrics: mitigated in ${ledger.metrics.timeToMitigateMs} ms, recovered in ${(ledger.metrics.timeToRecoverMs / 1000).toFixed(1)} s, flag restored ${ledger.metrics.timeToRestoreMs} ms after recovery`);
const postmortem = await (await fetch(`${BITACORA}/incidents/${incident.id}/postmortem`, { headers: { authorization: `Bearer ${ADMIN}` } })).text();
assert.match(postmortem, /## Timeline/);
writeFileSync('docs/postmortem-example.md', postmortem);
ok('postmortem drafted (saved to docs/postmortem-example.md)');

step(7, 'Evidence kept by each product');
const messages = await hr('GET', '/v1/messages?limit=50');
const thisRun = messages.data.filter((m) => m.createdAt >= runStartedAt);
console.log('   Hookrelay messages:', thisRun.map((m) => `${m.eventType} (${m.succeeded}/${m.fanout} delivered)`).reverse().join(', '));
console.log('   Flagship audit:   ', (await flagship('GET', `/api/flags/${flagKey}/audit`)).map((a) => a.action.split(':')[0].replace(/ [0-9a-f-]{36}/, '')).reverse().join(' -> '));

writeFileSync('.demo-state.json', JSON.stringify({ hookrelayApiKey: app.apiKey, flagKey, incidentId: incident.id, pipelineId: pipeline.id, messageId: thisRun.at(-1)?.id }, null, 2)); // handy for exploring the dashboards afterwards
console.log('\nAll assertions passed.');
process.exit(0);
