// Shared client for the Atalaya stack: used by demo.mjs (happy path) and chaos/run.mjs (game days).
// No dependencies. All inter-product traffic goes through Toxiproxy (see chaos/toxiproxy.json), which is
// transparent until an experiment adds a fault.
import { execSync } from 'node:child_process';

export const URLS = {
  hookrelay: 'http://localhost:3000',
  flagship: 'http://localhost:4000',
  nimbus: 'http://localhost:8080',
  bitacora: 'http://localhost:8090',
  toxiproxy: 'http://localhost:8474',
};
// How the products reach each other inside the Docker network (through the fault-injection proxy).
export const LINKS = {
  nimbusToFlagship: 'http://toxiproxy:14000',
  nimbusToHookrelay: 'http://toxiproxy:13000',
  hookrelayToOncall: 'http://toxiproxy:14100',
};
const ADMIN = process.env.ADMIN_TOKEN ?? 'change-me';
const NIMBUS_KEY = process.env.NIMBUS_API_KEY ?? 'nimbus-local-development-key';
export const ONCALL_URL = `${LINKS.hookrelayToOncall}/oncall`;

// Retry policy of the response and recovery workflow steps. Nimbus' default (3 attempts, 2 s backoff) gives
// up after ~6 s, shorter than a restart of Flagship: the flagship-blip game day showed the flag was then never
// killed. Both steps are idempotent, so a ~90 s budget (2, 4, 8, 16, 20, 20, 20 s) is safe and outlasts a deploy.
export const RESPONSE_RETRY = { maxAttempts: 8, initialDelaySeconds: 2, maxDelaySeconds: 20 };

export async function http(base, method, path, { body, headers } = {}) {
  const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...headers }, body: body && JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${base}${path} -> ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

export const flagship = (m, p, body, actor = 'atalaya-demo') => http(URLS.flagship, m, p, { body, headers: { authorization: `Bearer ${ADMIN}`, 'x-actor': actor } });
export const nimbus = (m, p, body) => http(URLS.nimbus, m, p, { body, headers: { authorization: `Bearer ${NIMBUS_KEY}` } });
export const bitacora = (m, p) => http(URLS.bitacora, m, p, { headers: { authorization: `Bearer ${ADMIN}` } });
export const bitacoraText = async (p) => (await fetch(URLS.bitacora + p, { headers: { authorization: `Bearer ${ADMIN}` } })).text();

export async function until(what, fn, timeoutMs = 60_000, everyMs = 500) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn().catch(() => undefined);
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

/** The platform tenant bootstrap.mjs created (Flagship publishes with its key, Bitácora is subscribed in it). */
export async function platform() {
  const state = JSON.parse(execSync('docker compose run --rm --no-deps -T --entrypoint cat bootstrap /state/platform.json', { encoding: 'utf8' }));
  const hr = (m, p, body) => http(URLS.hookrelay, m, p, { body, headers: { authorization: `Bearer ${state.hookrelayApiKey}` } });
  const endpoints = await hr('GET', '/v1/endpoints');
  const ONCALL_EVENTS = ['incident.opened', 'incident.recovered', 'incident.escalated'];
  let oncall = endpoints.find((e) => e.url === ONCALL_URL);
  if (oncall && !ONCALL_EVENTS.every((t) => oncall.eventTypes.includes(t))) { // subscribed before escalation existed
    await hr('DELETE', `/v1/endpoints/${oncall.id}`);
    oncall = null;
  }
  if (!oncall) oncall = await hr('POST', '/v1/endpoints', { url: ONCALL_URL, eventTypes: ONCALL_EVENTS, description: 'On-call system' });
  const bitacoraEndpoint = endpoints.find((e) => e.url.includes('/webhooks/hookrelay/'));
  // Production's SDK key, shared with the orders app. Issuing a new one would rotate it and revoke the
  // orders app's key on its next reconnect (found by a game day), so scenarios reuse it.
  let sdkKey = '';
  try { sdkKey = execSync('docker compose run --rm --no-deps -T --entrypoint cat bootstrap /state/orders-sdk-key', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch {}
  if (!sdkKey || !(await fetch(`${URLS.flagship}/sdk/v1/flags`, { headers: { authorization: `Bearer ${sdkKey}` } })).ok) {
    sdkKey = (await flagship('POST', '/api/environments/production/sdk-key')).sdkKey; // no orders app: nobody to revoke
  }
  return { ...state, hr, sdkKey, oncallEndpointId: oncall.id, bitacoraEndpointId: bitacoraEndpoint?.id };
}

/**
 * Fresh, isolated resources for one scenario run: a flag ON in production with an SDK stream attached,
 * the response and recovery workflows, and a fixture pipeline. Returns handles to drive and observe it.
 */
export async function prepareScenario(p, label, { retry = RESPONSE_RETRY } = {}) {
  const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  const flagKey = `orders-v2-${run}`;
  await flagship('POST', '/api/flags', { key: flagKey, name: `Orders v2 (${label})`, kind: 'boolean', variations: [false, true] });
  const created = await flagship('GET', `/api/flags/${flagKey}`);
  await flagship('PUT', `/api/flags/${flagKey}/envs/production`, { enabled: true, offVariation: 0, fallthrough: { variation: 1 }, rules: [], version: created.envs.production.version });

  // Minimal SDK: follow the stream and record every state change of this flag with a timestamp.
  const { sdkKey } = p;
  const sdk = { on: undefined, changes: [] };
  const abort = new AbortController();
  const stream = await fetch(`${URLS.flagship}/sdk/v1/stream`, { headers: { authorization: `Bearer ${sdkKey}` }, signal: abort.signal });
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
        if (flag && flag.enabled !== sdk.on) { sdk.on = flag.enabled; sdk.changes.push({ on: flag.enabled, at: Date.now() }); }
      }
    }
  })().catch(() => {});
  await until('SDK initial ruleset', async () => sdk.on === true);

  const steps = (eventType) => [
    { id: 'flag', type: 'http', ...(retry ? { retry } : {}), http: { method: 'POST', url: `${LINKS.nimbusToFlagship}/automation/nimbus/flags/${flagKey}/envs/production`, bodyMode: 'event' } },
    { id: 'notify', type: 'http', ...(retry ? { retry } : {}), http: { method: 'POST', url: `${LINKS.nimbusToHookrelay}/v1/inbound/nimbus/${p.hookrelayAppId}`, bodyMode: 'event' } },
  ];
  const workflow = (name, eventType) => nimbus('POST', '/v1/workflows', { name: `${name} ${run}`, definition: { schemaVersion: 1, eventType, steps: steps(eventType) } });
  const opened = await workflow('Kill switch + notify', 'nimbus.incident.opened');
  const recovered = await workflow('Restore + notify', 'nimbus.incident.recovered');
  // Escalation must not depend on what failed: it only notifies (on-call and Bitácora, through Hookrelay).
  const escalation = await nimbus('POST', '/v1/workflows', { name: `Escalate to on-call ${run}`, definition: { schemaVersion: 1, eventType: 'nimbus.incident.escalated', steps: steps('nimbus.incident.escalated').filter((s) => s.id === 'notify') } });
  const pipeline = await nimbus('POST', '/v1/pipelines', {
    name: `Orders async pipeline ${run}`, mode: 'fixture', region: 'us-east-1',
    queueArn: `arn:aws:sqs:us-east-1:123456789012:orders-${run}`,
    lambdaArn: `arn:aws:lambda:us-east-1:123456789012:function:orders-consumer-${run}`,
    dlqArn: `arn:aws:sqs:us-east-1:123456789012:orders-dlq-${run}`,
    incidentWorkflowId: opened.id, recoveryWorkflowId: recovered.id, escalationWorkflowId: escalation.id, consecutiveWindows: 2, backlogThreshold: 100, ageThresholdSeconds: 300,
  });

  const base = Math.floor(Date.now() / 300_000) * 300_000 - 4 * 300_000; // four closed 5-minute windows
  const observe = (n, metrics) => nimbus('POST', `/v1/pipelines/${pipeline.id}/observations`, {
    windowStartedAt: new Date(base + n * 300_000).toISOString(), windowEndedAt: new Date(base + (n + 1) * 300_000).toISOString(),
    inFlightMessages: 0, oldestMessageSeconds: 0, dlqMessages: 0, lambdaErrors: 0, lambdaThrottles: 0, ...metrics,
  });

  const scenario = {
    run, flagKey, pipeline, sdk, incident: null, workflows: { opened, recovered, escalation },
    /** Two degraded windows: backlog 200, oldest message 10 min, consumer with 0 invocations. */
    async stall() {
      const stalled = { visibleMessages: 200, oldestMessageSeconds: 600, lambdaInvocations: 0 };
      await observe(0, stalled);
      scenario.stalledAt = Date.now();
      await observe(1, stalled);
    },
    async waitIncident(timeoutMs = 60_000) {
      scenario.incident = await until('incident opened', async () => (await nimbus('GET', '/v1/incidents')).items?.find((i) => i.pipelineId === pipeline.id), timeoutMs);
      scenario.incidentSeenAt = Date.now();
      return scenario.incident;
    },
    /** Two healthy windows. */
    async recover() {
      const healthy = { visibleMessages: 3, lambdaInvocations: 250 };
      await observe(2, healthy);
      await observe(3, healthy);
      scenario.recoveredAt = Date.now();
    },
    close: () => abort.abort(),
  };
  return scenario;
}

/** Every delivery Hookrelay made for this incident's messages, per endpoint, with attempts. */
export async function deliveries(p, incidentId) {
  const { data } = await p.hr('GET', '/v1/messages?limit=100');
  const out = [];
  for (const m of data.filter((x) => x.eventType.startsWith('incident.'))) {
    const detail = await p.hr('GET', `/v1/messages/${m.id}`);
    if (detail.payload?.incidentId !== incidentId) continue;
    for (const d of detail.deliveries) out.push({ messageId: m.id, eventType: m.eventType, endpointId: d.endpointId, url: d.endpointUrl, status: d.status, attempts: d.attempts });
  }
  return out;
}

export const flagAudit = (flagKey) => flagship('GET', `/api/flags/${flagKey}/audit`);
