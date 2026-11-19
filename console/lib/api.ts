import 'server-only';
import { readFile } from 'node:fs/promises';
import { unstable_rethrow } from 'next/navigation';
import { connection } from 'next/server';
import { requireUser } from './auth';

// BFF: product URLs and credentials live only on this server; the browser never sees a token.
const env = (name: string, fallback: string) => process.env[name] ?? fallback;
const URLS = {
  nimbus: env('NIMBUS_URL', 'http://localhost:8080'),
  flagship: env('FLAGSHIP_URL', 'http://localhost:4000'),
  hookrelay: env('HOOKRELAY_URL', 'http://localhost:3000'),
  bitacora: env('BITACORA_URL', 'http://localhost:8090'),
};
// Links to each product's own UI, for drilling down (as seen from the browser).
export const UI = {
  nimbus: env('NIMBUS_UI', 'http://localhost:8080/app/'),
  flagship: env('FLAGSHIP_UI', 'http://localhost:4000/'),
  hookrelay: env('HOOKRELAY_UI', 'http://localhost:3000/docs'),
};
/** Nimbus uses the incident ID as the trace ID, so the trace link needs no lookup. */
export const traceUrl = (incidentId: string) => `${env('JAEGER_UI', 'http://localhost:16686')}/trace/${incidentId.replaceAll('-', '')}`;

/** The platform tenant's Hookrelay key: from the bootstrap state file (Docker) or the environment. */
async function hookrelayKey(): Promise<string> {
  if (process.env.HOOKRELAY_API_KEY) return process.env.HOOKRELAY_API_KEY;
  const state = JSON.parse(await readFile(env('PLATFORM_STATE', '/state/platform.json'), 'utf8'));
  return state.hookrelayApiKey;
}

export class ProductError extends Error {
  constructor(public product: string, public status: number, message: string) {
    super(`${product}: ${message}`);
  }
}

async function get<T>(product: keyof typeof URLS, path: string, auth: string, accept = 'application/json'): Promise<T> {
  await connection(); // always render at request time: live data, runtime secrets
  await requireUser(); // every read is on behalf of a signed-in person
  const res = await fetch(URLS[product] + path, { cache: 'no-store', headers: { authorization: `Bearer ${auth}`, accept }, signal: AbortSignal.timeout(5000) })
    .catch((e: Error) => { throw new ProductError(product, 503, e.message); });
  if (!res.ok) throw new ProductError(product, res.status, res.statusText);
  return (accept === 'application/json' ? res.json() : res.text()) as Promise<T>;
}

/** Writes, only from server actions (which authorize the operator first). */
async function send(product: keyof typeof URLS, method: string, path: string, auth: string, body?: unknown, headers: Record<string, string> = {}): Promise<unknown> {
  const res = await fetch(URLS[product] + path, {
    method, cache: 'no-store', signal: AbortSignal.timeout(5000),
    headers: { authorization: `Bearer ${auth}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).catch((e: Error) => { throw new ProductError(product, 503, e.message); });
  if (!res.ok) throw new ProductError(product, res.status, (await res.text().catch(() => '')).slice(0, 200) || res.statusText);
  return res.status === 204 ? null : res.json().catch(() => null);
}

const ADMIN = () => env('ADMIN_TOKEN', 'change-me');
const NIMBUS_KEY = () => env('NIMBUS_API_KEY', 'nimbus-local-development-key');

// ---------------------------------------------------------------- types (only the fields the console uses)
export interface LedgerIncident {
  incidentId: string; summary?: string; detector?: string; severity?: string; pipelineName?: string;
  openedAt?: string; mitigatedAt?: string; recoveredAt?: string; restoredAt?: string; flags: string[];
  status: 'open' | 'mitigated' | 'recovered'; timeToMitigateMs?: number; timeToRecoverMs?: number; timeToRestoreMs?: number;
}
export interface LedgerEntry { at: string; type: string; actor: string; text: string }
export interface NimbusIncident {
  id: string; pipelineName: string; detector: string; status: string; severity: string; summary: string;
  openedAt: string; escalatedAt?: string; recoveredAt?: string;
  evidence?: { windowStartedAt: string; windowEndedAt: string; visibleMessages: number; oldestMessageSeconds: number; lambdaInvocations: number; dlqMessages: number; lambdaErrors: number };
}
export interface AuditEntry { id: string; env: string; actor: string; action: string; createdAt: string }
export interface Delivery { id: string; endpointUrl: string; status: string; attempts: { attemptNo: number; statusCode: number | null; durationMs: number | null; error: string | null; createdAt: string }[] }
export interface HookrelayMessage { id: string; eventType: string; createdAt: string; payload: Record<string, unknown>; deliveries: Delivery[] }
export interface DeliveryStats { succeeded: number; failed: number; pending: number; successRate: number | null; p50: number | null; p95: number | null }

// ---------------------------------------------------------------- reads
export const listIncidents = async (limit = 50) => (await get<{ items: LedgerIncident[] }>('bitacora', `/incidents?limit=${limit}`, ADMIN())).items;
export const ledger = (id: string) => get<{ incident: LedgerIncident; metrics: Omit<LedgerIncident, 'incidentId' | 'flags'>; timeline: LedgerEntry[] }>('bitacora', `/incidents/${encodeURIComponent(id)}`, ADMIN());
export const postmortem = (id: string) => get<string>('bitacora', `/incidents/${encodeURIComponent(id)}/postmortem`, ADMIN(), 'text/markdown');
export const nimbusIncident = (id: string) => get<NimbusIncident>('nimbus', `/v1/incidents/${encodeURIComponent(id)}`, NIMBUS_KEY());
export const pipelines = async () => (await get<{ items: { id: string }[] }>('nimbus', '/v1/pipelines', NIMBUS_KEY())).items;
export const flagAudit = (flagKey: string) => get<AuditEntry[]>('flagship', `/api/flags/${encodeURIComponent(flagKey)}/audit`, ADMIN());
export const flags = () => get<{ key: string; enabled: boolean }[]>('flagship', '/api/flags', ADMIN());
export const deliveryStats = async () => get<DeliveryStats>('hookrelay', '/v1/stats', await hookrelayKey());
export const deadLetterCount = async () => (await get<{ total: number }>('hookrelay', '/v1/dead-letters?limit=1', await hookrelayKey())).total;

// ---------------------------------------------------------------- actions (operators, via app/actions.ts)
export const acknowledgeIncident = (id: string) => send('nimbus', 'POST', `/v1/incidents/${encodeURIComponent(id)}/acknowledgements`, NIMBUS_KEY());
export const resendDelivery = async (id: string) => send('hookrelay', 'POST', `/v1/deliveries/${encodeURIComponent(id)}/retry`, await hookrelayKey());
export interface FlagEnv { enabled: boolean; offVariation: number; fallthrough: unknown; rules: unknown[]; version: number }
export async function flagEnv(key: string, envKey: string): Promise<FlagEnv> {
  const flag = await get<{ envs: Record<string, FlagEnv> }>('flagship', `/api/flags/${encodeURIComponent(key)}`, ADMIN());
  if (!flag.envs[envKey]) throw new ProductError('flagship', 404, `no ${envKey} environment`);
  return flag.envs[envKey];
}
/** Optimistic: Flagship rejects the write if someone changed the flag since `current.version`. */
export const setFlagEnabled = (key: string, envKey: string, next: FlagEnv, actor: string) =>
  send('flagship', 'PUT', `/api/flags/${encodeURIComponent(key)}/envs/${encodeURIComponent(envKey)}`, ADMIN(),
    { enabled: next.enabled, offVariation: next.offVariation, fallthrough: next.fallthrough, rules: next.rules, version: next.version }, { 'x-actor': actor });

/** Hookrelay messages about this incident, with every delivery attempt per endpoint. */
export async function incidentMessages(incidentId: string): Promise<HookrelayMessage[]> {
  const key = await hookrelayKey();
  const { data } = await get<{ data: { id: string; eventType: string }[] }>('hookrelay', '/v1/messages?limit=100', key);
  const details = await Promise.all(data.filter((m) => m.eventType.startsWith('incident.')).map((m) => get<HookrelayMessage>('hookrelay', `/v1/messages/${m.id}`, key)));
  return details.filter((m) => m.payload?.incidentId === incidentId).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}

/** Latest game day report written by chaos/run.mjs (mounted read-only into the container). */
export async function latestGameDay(): Promise<GameDay | null> {
  await connection(); // read the newest report on every request, not once at build time
  await requireUser();
  const dir = env('REPORTS_DIR', '/reports');
  const { readdir } = await import('node:fs/promises');
  const files = (await readdir(dir).catch(() => [] as string[])).filter((f) => f.endsWith('.json')).sort();
  if (!files.length) return null;
  const file = files.at(-1)!;
  return { file, experiments: JSON.parse(await readFile(`${dir}/${file}`, 'utf8')) };
}
export interface GameDay {
  file: string;
  experiments: { name: string; title: string; hypothesis: string; status: string; durationMs: number; faults: { link: string; type: string; ms?: number; at: string; seconds?: number; until?: string }[]; checks: { probe: string; ok: boolean; observed?: string; withinSeconds: number; event?: string; endpoint?: string }[]; abortReason?: string }[];
}

/** Settles a read so one product being down degrades a panel instead of failing the page. */
export async function settle<T>(p: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  try {
    return { ok: true, value: await p };
  } catch (e) {
    unstable_rethrow(e); // never swallow Next's control flow: the redirect to sign-in must win
    return { ok: false, error: (e as Error).message };
  }
}
