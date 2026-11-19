// One-shot (docker compose): connects the protected app to the platform, idempotently.
//   Flagship: flag `checkout-v2` (ON when first created; later changes by people are kept) + an SDK key
//   Nimbus:   response/recovery workflows + a push pipeline (30 s windows) on the real orders queue
// Writes /state/orders-sdk-key and /state/orders.json (pipelineId) for the service and the agent.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { RESPONSE_RETRY } from '../lib/atalaya.mjs';

const FLAGSHIP = process.env.FLAGSHIP_URL ?? 'http://flagship:4000';
const NIMBUS = process.env.NIMBUS_URL ?? 'http://nimbus:8080';
const ADMIN = process.env.ADMIN_TOKEN ?? 'change-me';
const NIMBUS_KEY = process.env.NIMBUS_API_KEY ?? 'nimbus-local-development-key';
const FLAG = 'checkout-v2';
const PIPELINE = 'Orders (protected app)';
const platform = JSON.parse(readFileSync('/state/platform.json', 'utf8'));

async function call(base, method, path, { body, headers } = {}) {
  const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...headers }, body: body && JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok && res.status !== 404) throw new Error(`${method} ${base}${path} -> ${res.status} ${text.slice(0, 300)}`);
  return { status: res.status, json: text ? JSON.parse(text) : null };
}
const flagship = (m, p, body) => call(FLAGSHIP, m, p, { body, headers: { authorization: `Bearer ${ADMIN}`, 'x-actor': 'atalaya-provision' } });
const nimbus = (m, p, body) => call(NIMBUS, m, p, { body, headers: { authorization: `Bearer ${NIMBUS_KEY}` } });

for (const [name, url] of [['Flagship', `${FLAGSHIP}/health`], ['Nimbus', `${NIMBUS}/health/ready`]]) {
  for (let i = 0; ; i++) {
    if ((await fetch(url).catch(() => null))?.ok) break;
    if (i > 90) throw new Error(`${name} did not come up`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

// ---------------------------------------------------------------- Flagship: the kill switch and the SDK key
if ((await flagship('GET', `/api/flags/${FLAG}`)).status === 404) {
  await flagship('POST', '/api/flags', { key: FLAG, name: 'Checkout v2 (async orders pipeline)', kind: 'boolean', variations: [false, true] });
  const created = (await flagship('GET', `/api/flags/${FLAG}`)).json;
  await flagship('PUT', `/api/flags/${FLAG}/envs/production`, { enabled: true, offVariation: 0, fallthrough: { variation: 1 }, rules: [], version: created.envs.production.version });
  console.log(`created ${FLAG}, ON in production`);
}
const keyFile = '/state/orders-sdk-key';
const keyValid = existsSync(keyFile) && (await fetch(`${FLAGSHIP}/sdk/v1/flags`, { headers: { authorization: `Bearer ${readFileSync(keyFile, 'utf8').trim()}` } })).ok;
if (!keyValid) {
  writeFileSync(keyFile, (await flagship('POST', '/api/environments/production/sdk-key')).json.sdkKey);
  console.log('issued a production SDK key for the orders service');
}

// ---------------------------------------------------------------- Nimbus: who to call, and what to watch
const pipelines = (await nimbus('GET', '/v1/pipelines')).json.items;
let pipeline = pipelines.find((p) => p.name === PIPELINE);
if (!pipeline) {
  const steps = [
    { id: 'flag', type: 'http', retry: RESPONSE_RETRY, http: { method: 'POST', url: `http://toxiproxy:14000/automation/nimbus/flags/${FLAG}/envs/production`, bodyMode: 'event' } },
    { id: 'notify', type: 'http', retry: RESPONSE_RETRY, http: { method: 'POST', url: `http://toxiproxy:13000/v1/inbound/nimbus/${platform.hookrelayAppId}`, bodyMode: 'event' } },
  ];
  const workflow = async (name, eventType) => (await nimbus('POST', '/v1/workflows', { name, definition: { schemaVersion: 1, eventType, steps } })).json;
  const opened = await workflow('Orders: kill checkout-v2 + notify', 'nimbus.incident.opened');
  const recovered = await workflow('Orders: restore checkout-v2 + notify', 'nimbus.incident.recovered');
  // If the kill switch cannot be pulled, page a human. Only the notify step: Flagship is what failed.
  const escalation = (await nimbus('POST', '/v1/workflows', { name: 'Orders: escalate to on-call', definition: { schemaVersion: 1, eventType: 'nimbus.incident.escalated', steps: [steps[1]] } })).json;
  pipeline = (await nimbus('POST', '/v1/pipelines', {
    name: PIPELINE, mode: 'fixture', region: 'us-east-1', windowSeconds: 30,
    queueArn: 'arn:aws:sqs:us-east-1:000000000000:orders', lambdaArn: 'arn:aws:lambda:us-east-1:000000000000:function:orders-consumer',
    dlqArn: 'arn:aws:sqs:us-east-1:000000000000:orders-dlq',
    incidentWorkflowId: opened.id, recoveryWorkflowId: recovered.id, escalationWorkflowId: escalation.id, consecutiveWindows: 2, backlogThreshold: 50, ageThresholdSeconds: 20,
  })).json;
  console.log(`watching the orders queue: pipeline ${pipeline.id} (30 s windows, 2 windows to open)`);
}
if (!pipeline.escalationWorkflowId) console.warn('WARNING: the orders pipeline predates escalation (Nimbus cannot edit pipelines): recreate Nimbus\' database to get it');
writeFileSync('/state/orders.json', JSON.stringify({ pipelineId: pipeline.id, flagKey: FLAG }, null, 2));
console.log('orders provisioned');
