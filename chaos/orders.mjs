// The "orders" game-day scenario: faults hit the real protected app (k6 traffic, SQS, Lambda-style
// consumer), and Nimbus detects them from the agent's real queue metrics, not from injected numbers.
import { execSync } from 'node:child_process';
import { bitacora, flagship, nimbus, until } from '../lib/atalaya.mjs';

const ORDERS = 'http://localhost:8081';
const SQS = 'http://localhost:9324/000000000000';
const FLAG = 'checkout-v2';

const compose = (args) => execSync(`docker compose ${args}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
export const processFault = {
  inject: (service) => compose(`stop ${service}`),
  heal: (service) => compose(`start ${service}`),
};

const metric = (text, name, labels) => text.split('\n').filter((l) => l.startsWith(name) && Object.entries(labels).every(([k, v]) => l.includes(`${k}="${v}"`))).reduce((s, l) => s + Number(l.split(' ').at(-1)), 0);
async function ordersMetrics() {
  const text = await (await fetch(`${ORDERS}/metrics`)).text();
  return { v1: metric(text, 'orders_total', { path: 'v1' }), v2: metric(text, 'orders_total', { path: 'v2' }), failed: metric(text, 'orders_total', { result: 'failed' }) };
}
export async function queueDepth(queue = 'orders') {
  const xml = await (await fetch(`${SQS}/${queue}?Action=GetQueueAttributes&AttributeName.1=ApproximateNumberOfMessages`)).text();
  return Number(/<Value>(\d+)<\/Value>/.exec(xml)?.[1] ?? NaN);
}
const flagOn = async () => (await flagship('GET', `/api/flags/${FLAG}`)).envs.production.enabled;

/** Steady state, then handles to observe one real incident on the orders pipeline. */
export async function prepareOrders() {
  const { pipelineId } = JSON.parse(compose('run --rm --no-deps -T --entrypoint cat bootstrap /state/orders.json'));
  const running = compose('ps --status running --format {{.Service}}').split('\n');
  for (const service of ['orders', 'orders-consumer', 'orders-agent', 'traffic']) {
    if (!running.includes(service)) throw Object.assign(new Error(`steady state: ${service} is not running`), { abort: true });
  }
  const open = (await nimbus('GET', '/v1/incidents')).items.find((i) => i.pipelineId === pipelineId && i.status !== 'recovered' && i.status !== 'resolved');
  if (open) throw Object.assign(new Error(`steady state: incident ${open.id} is still open on the orders pipeline`), { abort: true });
  if (!(await flagOn())) throw Object.assign(new Error(`steady state: ${FLAG} is off`), { abort: true });
  if (!((await queueDepth()) < 50)) throw Object.assign(new Error('steady state: the orders queue is backed up'), { abort: true });

  // Customers must actually be ordering: without traffic no incident opens and nothing is proven.
  const before = await ordersMetrics();
  await new Promise((r) => setTimeout(r, 3000));
  const baseline = await ordersMetrics();
  if (baseline.v1 + baseline.v2 - before.v1 - before.v2 < 5) throw Object.assign(new Error('steady state: no customer traffic is reaching the orders service'), { abort: true });
  const startedAt = new Date().toISOString();
  const s = {
    pipelineId, baseline, startedAt, incident: null,
    async waitIncident(timeoutMs) {
      s.incident = await until('incident opened from real metrics', async () => (await nimbus('GET', '/v1/incidents')).items.find((i) => i.pipelineId === pipelineId && i.openedAt >= startedAt), timeoutMs, 2000);
      s.incidentSeenAt = Date.now();
      return s.incident;
    },
    close() {},
  };
  return s;
}

export function ordersProbes(s) {
  const since = (iso) => Math.round((Date.parse(iso) - Date.parse(s.incident.openedAt)) / 1000);
  return {
    async flagOff() {
      if (await flagOn()) return null;
      const kill = (await flagship('GET', `/api/flags/${FLAG}/audit`)).find((a) => a.action.startsWith(`killed by nimbus incident ${s.incident.id}`));
      const detectedAfter = Math.round((Date.parse(s.incident.openedAt) - Date.parse(s.startedAt)) / 1000);
      return kill && { observed: `Nimbus opened the incident ${detectedAfter} s after the fault; ${FLAG} OFF ${since(kill.createdAt)} s later` };
    },
    async ordersNeverFailed() {
      const m = await ordersMetrics();
      const failed = m.failed - s.baseline.failed;
      return failed === 0 ? { observed: `0 failed orders; ${m.v1 + m.v2 - s.baseline.v1 - s.baseline.v2} accepted since the fault` } : null;
    },
    async servedByV1() {
      const v1 = (await ordersMetrics()).v1 - s.baseline.v1;
      return v1 > 0 && { observed: `${v1} orders served by the synchronous v1 path while v2 was off` };
    },
    async recovered() {
      const i = await nimbus('GET', `/v1/incidents/${s.incident.id}`);
      return i.recoveredAt && { observed: `Nimbus recovered the incident ${Math.round((Date.parse(i.recoveredAt) - s.healedAt) / 1000)} s after the fault was healed` };
    },
    async flagRestored() {
      return (await flagOn()) && { observed: `${FLAG} back ON ${Math.round((Date.now() - s.healedAt) / 1000)} s after the fault was healed` };
    },
    async queueDrained() {
      return (await queueDepth()) === 0 && { observed: 'orders queue drained to 0' };
    },
    async timeline(c) {
      const r = await bitacora('GET', `/incidents/${s.incident.id}`).catch(() => null);
      const types = r?.timeline.map((t) => t.type) ?? [];
      s.lastTimeline = types;
      return JSON.stringify(types) === JSON.stringify(c.types) && { observed: `Bitácora timeline: ${types.join(' → ')}` };
    },
  };
}

