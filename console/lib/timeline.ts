// One incident timeline across the four products, built from each product's own record.
// Pure: no I/O, so it is unit-tested without the stack (test/timeline.test.ts).

export type Product = 'nimbus' | 'flagship' | 'hookrelay' | 'bitacora';
export type Tone = 'bad' | 'ok' | 'warn' | 'neutral';
export interface Event { at: string; product: Product; title: string; detail?: string; tone: Tone }

interface Inputs {
  nimbus?: { detector: string; summary: string; openedAt: string; escalatedAt?: string; recoveredAt?: string; evidence?: { windowEndedAt: string; visibleMessages: number; oldestMessageSeconds: number; lambdaInvocations: number } };
  audit?: { flag: string; entries: { actor: string; action: string; createdAt: string }[] }[];
  messages?: { eventType: string; deliveries: { endpointUrl: string; status?: string; attempts: { statusCode: number | null; durationMs: number | null; error: string | null; createdAt: string }[] }[] }[];
  ledger?: { restoredAt?: string; mitigatedAt?: string };
}

/** Human name of a webhook endpoint: Bitácora's ingest path, the demo's on-call receiver, or the host. */
export function endpointName(url: string): string {
  if (url.includes('/webhooks/hookrelay/')) return 'Bitácora';
  if (url.endsWith('/oncall')) return 'On-call';
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

const minutes = (s: number) => (s >= 60 ? `${Math.round(s / 60)} min` : `${s} s`);

export function buildTimeline({ nimbus, audit = [], messages = [], ledger }: Inputs): Event[] {
  const events: Event[] = [];
  if (nimbus) {
    if (nimbus.evidence) {
      const e = nimbus.evidence;
      events.push({ at: e.windowEndedAt, product: 'nimbus', tone: 'warn', title: 'Degraded window closed', detail: `backlog ${e.visibleMessages}, oldest message ${minutes(e.oldestMessageSeconds)}, ${e.lambdaInvocations} consumer invocations` });
    }
    events.push({ at: nimbus.openedAt, product: 'nimbus', tone: 'bad', title: `Incident opened · ${nimbus.detector}`, detail: nimbus.summary });
    if (nimbus.escalatedAt) events.push({ at: nimbus.escalatedAt, product: 'nimbus', tone: 'bad', title: 'Mitigation failed · escalated to on-call', detail: 'the response workflow ran out of retries: a human has to act' });
    if (nimbus.recoveredAt) events.push({ at: nimbus.recoveredAt, product: 'nimbus', tone: 'ok', title: 'Incident recovered', detail: 'two healthy windows' });
  }

  // Only flag changes that belong to this incident: from just before it opened until the flag was restored.
  const from = nimbus ? Date.parse(nimbus.openedAt) - 60_000 : -Infinity;
  const until = Date.parse(ledger?.restoredAt ?? nimbus?.recoveredAt ?? '') + 5 * 60_000 || Infinity;
  for (const { flag, entries } of audit) {
    for (const a of entries) {
      const t = Date.parse(a.createdAt);
      if (t < from || t > until) continue;
      const kill = a.action.startsWith('killed by');
      const restore = a.action.startsWith('rolled back');
      events.push({
        at: a.createdAt, product: 'flagship', tone: kill ? 'bad' : restore ? 'ok' : 'neutral',
        title: kill ? `${flag} turned OFF (kill switch)` : restore ? `${flag} restored` : `${flag}: ${a.action}`,
        detail: `by ${a.actor}${kill ? ' · SDKs switch to the safe path' : ''}`,
      });
    }
  }

  for (const m of messages) {
    for (const d of m.deliveries) {
      d.attempts.forEach((a, i) => {
        const ok = a.statusCode !== null && a.statusCode >= 200 && a.statusCode < 300;
        const last = i === d.attempts.length - 1;
        // A failure is either retried, or (last attempt of a delivery that ended failed) parked in the DLQ.
        const next = last && d.status === 'failed' ? 'parked in the DLQ' : last && d.status === 'pending' ? 'retry scheduled' : 'retried';
        events.push({
          at: a.createdAt, product: 'hookrelay', tone: ok ? 'ok' : last && d.status === 'failed' ? 'bad' : 'warn',
          title: `${m.eventType} → ${endpointName(d.endpointUrl)}`,
          detail: ok ? `${a.statusCode} in ${a.durationMs} ms${i > 0 ? ` · after ${i} failed attempt${i > 1 ? 's' : ''}` : ''}` : `failed${a.statusCode ? ` (${a.statusCode})` : ''}: ${a.error ?? 'no response'} · ${next}`,
        });
      });
    }
  }

  return events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.product.localeCompare(b.product));
}

/** Median and 95th percentile (nearest-rank) of the numbers given; undefined when empty. */
export function percentiles(values: number[]): { p50?: number; p95?: number } {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return {};
  const rank = (p: number) => v[Math.min(v.length - 1, Math.ceil((p / 100) * v.length) - 1)];
  return { p50: rank(50), p95: rank(95) };
}

export function duration(ms?: number): string {
  if (ms === undefined || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  return `${m} min ${Math.round(s - m * 60)} s`;
}
