// One-shot setup run by `docker compose up` before Flagship starts. Connects the products that
// publish to Hookrelay with the ones that subscribe to it, the way an operator would:
//   1. a Hookrelay tenant for the platform (its API key lets Flagship publish flag.* events)
//   2. a Bitácora webhook source, subscribed in Hookrelay to incident.* and flag.*
// Idempotent: valid state from a previous run is reused; if any side lost its data
// (fresh containers), everything is recreated. Writes /state/platform.json and /state/hookrelay-api-key.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const HOOKRELAY = process.env.HOOKRELAY_URL ?? 'http://hookrelay-api:3000';
const BITACORA = process.env.BITACORA_URL ?? 'http://bitacora:8090';
const ADMIN = process.env.ADMIN_TOKEN ?? 'change-me';
const BITACORA_TOKEN = process.env.BITACORA_TOKEN ?? 'change-me';
const STATE = '/state/platform.json';
const EVENT_TYPES = ['incident.opened', 'incident.recovered', 'flag.created', 'flag.updated', 'flag.archived'];

async function call(base, method, path, { body, headers } = {}) {
  const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...headers }, body: body && JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

async function expectOk(base, method, path, opts) {
  const res = await call(base, method, path, opts);
  if (res.status >= 300) throw new Error(`${method} ${base}${path} -> ${res.status} ${JSON.stringify(res.json)}`);
  return res.json;
}

async function waitFor(name, url) {
  for (let i = 0; i < 90; i++) {
    try {
      await fetch(url);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error(`${name} did not come up at ${url}`);
}

const hookrelayAuth = (key) => ({ authorization: `Bearer ${key}` });
const bitacoraAuth = { authorization: `Bearer ${BITACORA_TOKEN}` };

/** The tenant still exists in Hookrelay (its database may have been recreated). */
async function tenantValid(state) {
  return (await call(HOOKRELAY, 'GET', '/v1/endpoints', { headers: hookrelayAuth(state.hookrelayApiKey) })).status === 200;
}

/** Bitácora knows the source and it has its secret: an unsigned probe gets 401 (404 = unknown, 409 = not connected). */
async function sourceValid(state) {
  return (await call(BITACORA, 'POST', `/webhooks/hookrelay/${state.bitacoraSourceId}`, { body: {} })).status === 401;
}

/** New Bitácora source, subscribed in the tenant; replaces any Bitácora endpoint left from a lost source. */
async function connectBitacora(apiKey) {
  const existing = await expectOk(HOOKRELAY, 'GET', '/v1/endpoints', { headers: hookrelayAuth(apiKey) });
  for (const e of existing.filter((e) => e.url.includes('/webhooks/hookrelay/'))) {
    await expectOk(HOOKRELAY, 'DELETE', `/v1/endpoints/${e.id}`, { headers: hookrelayAuth(apiKey) });
  }
  const source = await expectOk(BITACORA, 'POST', '/sources', { body: { name: 'hookrelay · atalaya-platform' }, headers: bitacoraAuth });
  const endpoint = await expectOk(HOOKRELAY, 'POST', '/v1/endpoints', {
    body: { url: source.webhookUrl, eventTypes: EVENT_TYPES, description: 'Bitácora incident ledger' },
    headers: hookrelayAuth(apiKey),
  });
  await expectOk(BITACORA, 'PUT', `/sources/${source.id}/secret`, { body: { secret: endpoint.secret }, headers: bitacoraAuth });
  return source.id;
}

await waitFor('Hookrelay', `${HOOKRELAY}/health`);
await waitFor('Bitácora', `${BITACORA}/health`);

let state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : null;
// Repair only the side that lost its data: keeping the tenant keeps the API key Flagship publishes with.
if (!state || !(await tenantValid(state))) {
  const app = await expectOk(HOOKRELAY, 'POST', '/v1/apps', { body: { name: 'atalaya-platform' }, headers: { 'x-admin-token': ADMIN } });
  state = { hookrelayAppId: app.id, hookrelayApiKey: app.apiKey, bitacoraSourceId: await connectBitacora(app.apiKey) };
  console.log(`created platform tenant ${app.id}; Bitácora subscribed to ${EVENT_TYPES.join(', ')}`);
} else if (!(await sourceValid(state))) {
  state.bitacoraSourceId = await connectBitacora(state.hookrelayApiKey);
  console.log(`reconnected Bitácora (source ${state.bitacoraSourceId}) to tenant ${state.hookrelayAppId}`);
} else {
  console.log(`platform tenant ${state.hookrelayAppId} and Bitácora source still valid`);
}
writeFileSync(STATE, JSON.stringify(state, null, 2));
// Flagship reads this through HOOKRELAY_API_KEY_FILE (Docker secrets convention).
writeFileSync('/state/hookrelay-api-key', state.hookrelayApiKey);
