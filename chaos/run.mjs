// Atalaya game days: declarative chaos experiments against the running stack.
//   node chaos/run.mjs                  # every experiment in chaos/experiments
//   node chaos/run.mjs flagship-blip    # one by name
// Each experiment: steady-state check -> fresh scenario -> inject network faults (Toxiproxy, no app
// changes) at a phase -> verify the hypothesis with real product data -> always heal -> report.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { bitacora, bitacoraText, deliveries, http, platform, prepareScenario, until, URLS } from '../lib/atalaya.mjs';
import { ordersProbes, prepareOrders, processFault } from './orders.mjs';

const here = new URL('.', import.meta.url).pathname;
const toxiproxy = (m, p, body) => http(URLS.toxiproxy, m, p, { body });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- faults
// Network faults through Toxiproxy (`link`), process faults through Docker (`service`). Never app code.
const FAULTS = {
  down: { inject: (f) => toxiproxy('POST', `/proxies/${f.link}`, { enabled: false }), heal: (f) => toxiproxy('POST', `/proxies/${f.link}`, { enabled: true }) },
  latency: {
    inject: (f) => toxiproxy('POST', `/proxies/${f.link}/toxics`, { name: 'latency', type: 'latency', stream: 'upstream', attributes: { latency: f.ms, jitter: 0 } }),
    heal: (f) => toxiproxy('DELETE', `/proxies/${f.link}/toxics/latency`),
  },
  stop: { inject: async (f) => processFault.inject(f.service), heal: async (f) => processFault.heal(f.service) },
};
const target = (f) => f.link ?? f.service;

// ---------------------------------------------------------------- probes (read real product state)
// Each returns { ok, observed } once its condition holds, or throws when the deadline passes.
function probes(p, s) {
  const endpointId = (name) => ({ oncall: p.oncallEndpointId, bitacora: p.bitacoraEndpointId })[name];
  const delivery = async (c, status) => (await deliveries(p, s.incident.id)).find((d) => d.endpointId === endpointId(c.endpoint) && d.eventType === c.event && d.status === status);
  return {
    async flagKilled() {
      const off = s.sdk.changes.find((c) => c.on === false);
      return off && { observed: `flag off ${off.at - s.stalledAt} ms after the incident's second degraded window` };
    },
    async flagRestored() {
      const back = s.sdk.changes.find((c) => c.on === true && c.at >= (s.recoveredAt ?? Infinity));
      return back && { observed: `flag back on ${back.at - s.recoveredAt} ms after recovery` };
    },
    async delivered(c) {
      const d = await delivery(c, 'succeeded');
      return d && { observed: `${c.event} → ${c.endpoint}: delivered after ${d.attempts.length} attempt(s)` };
    },
    async deadLettered(c) {
      const d = await delivery(c, 'failed');
      return d && { observed: `${c.event} → ${c.endpoint}: in the DLQ after ${d.attempts.length} attempts` };
    },
    async timeline(c) {
      const r = await bitacora('GET', `/incidents/${s.incident.id}`).catch(() => null);
      const types = r?.timeline.map((t) => t.type) ?? [];
      s.lastTimeline = types;
      return JSON.stringify(types) === JSON.stringify(c.types) && { observed: `Bitácora timeline: ${types.join(' → ')}` };
    },
    async postmortemSays(c) {
      const md = await bitacoraText(`/incidents/${s.incident.id}/postmortem`);
      return md.includes(c.text) && { observed: `postmortem says "${c.text}"` };
    },
  };
}

async function check(probe, c) {
  const started = Date.now();
  try {
    const r = await until(c.probe, () => probe(c), c.withinSeconds * 1000, 1000);
    return { ...c, ok: true, observed: r.observed, tookMs: Date.now() - started };
  } catch {
    return { ...c, ok: false, tookMs: Date.now() - started };
  }
}

// ---------------------------------------------------------------- one experiment
async function runExperiment(p, x) {
  const started = Date.now();
  const report = { name: x.name, title: x.title, hypothesis: x.hypothesis, faults: x.faults, status: 'passed', checks: [], startedAt: new Date(started).toISOString() };
  const active = new Set();
  const timers = [];
  const heal = async (f) => { if (active.delete(f)) await FAULTS[f.type].heal(f); };
  const apply = async (f) => {
    await FAULTS[f.type].inject(f);
    active.add(f);
    if (f.seconds) timers.push(setTimeout(() => heal(f).catch(() => {}), f.seconds * 1000));
  };
  // delaySeconds: inject part-way through the experiment (e.g. a database outage while an incident unfolds).
  const inject = (f) => (f.delaySeconds ? void timers.push(setTimeout(() => apply(f).catch(() => {}), f.delaySeconds * 1000)) : apply(f));
  const at = (phase) => Promise.all(x.faults.filter((f) => f.at === phase).map(inject));
  const healUntil = (phase) => Promise.all([...active].filter((f) => f.until === phase).map(heal));
  const verify = async (pr, phase) => {
    const results = await Promise.all(x.checks.filter((c) => (c.phase ?? 'incident') === phase).map((c) => check(pr[c.probe], c)));
    report.checks.push(...results);
  };

  // Abort guard: an experiment never runs longer than its budget, and always heals.
  const maxSeconds = x.maxSeconds ?? (x.scenario === 'orders' ? 480 : 240);
  const budget = setTimeout(() => { report.status = 'aborted'; report.abortReason = `exceeded ${maxSeconds} s`; }, maxSeconds * 1000);
  let s;
  try {
    if (x.scenario === 'orders') {
      // Real app: the fault itself must make Nimbus open the incident, from the agent's real queue metrics.
      await toxiproxy('POST', '/reset');
      s = await prepareOrders();
      const pr = ordersProbes(s);
      await at('start');
      const detectStarted = Date.now();
      const detected = await s.waitIncident((x.detectWithinSeconds ?? 180) * 1000).then(() => true, () => false);
      report.checks.push({ probe: 'incidentOpened', withinSeconds: x.detectWithinSeconds ?? 180, ok: detected, tookMs: Date.now() - detectStarted, observed: detected ? `Nimbus opened ${s.incident.detector} from real metrics ${Math.round((Date.parse(s.incident.openedAt) - Date.parse(s.startedAt)) / 1000)} s after the fault` : undefined });
      if (detected) {
        await at('incident');
        await verify(pr, 'incident');
      }
      await healUntil('recover');
      s.healedAt = Date.now();
      if (detected) await verify(pr, 'recovery');
      await healUntil('end');
      if (detected) await verify(pr, 'after');
      if (report.status !== 'aborted' && report.checks.some((c) => !c.ok)) report.status = 'failed';
      if (s.lastTimeline) report.timeline = s.lastTimeline;
      return report;
    }
    // Steady state: links clean and every product healthy before anything is broken.
    await toxiproxy('POST', '/reset');
    for (const [name, url] of Object.entries({ hookrelay: `${URLS.hookrelay}/health`, flagship: `${URLS.flagship}/health`, bitacora: `${URLS.bitacora}/health`, nimbus: `${URLS.nimbus}/health/ready` })) {
      const res = await fetch(url).catch(() => null);
      if (!res?.ok) throw Object.assign(new Error(`steady state: ${name} is not healthy`), { abort: true });
    }
    s = await prepareScenario(p, x.name); // the platform's real workflow configuration, same as the demo
    const pr = probes(p, s);

    await at('stall');
    await s.stall();
    await s.waitIncident().catch(() => { throw Object.assign(new Error('steady state: Nimbus did not open the incident'), { abort: true }); });
    await at('incident');
    await verify(pr, 'incident');

    await healUntil('recover');
    await s.recover();
    await at('recover');
    await verify(pr, 'recovery');

    await healUntil('end');
    for (const a of x.after ?? []) {
      if (a.action === 'replay') {
        const endpointId = { oncall: p.oncallEndpointId, bitacora: p.bitacoraEndpointId }[a.endpoint];
        const { replayed } = await p.hr('POST', '/v1/dead-letters/replay', { endpointId, limit: 100 });
        report.replayed = (report.replayed ?? 0) + replayed;
      }
      if (a.action === 'wait') await sleep(a.seconds * 1000);
    }
    await verify(pr, 'after');
    if (report.status !== 'aborted' && report.checks.some((c) => !c.ok)) report.status = 'failed';
    if (s.lastTimeline) report.timeline = s.lastTimeline;
  } catch (e) {
    report.status = e.abort ? 'aborted' : 'error';
    report.abortReason = e.message;
  } finally {
    clearTimeout(budget);
    timers.forEach(clearTimeout);
    await toxiproxy('POST', '/reset').catch(() => {});
    await Promise.all([...active].map((f) => heal(f).catch(() => {}))); // processes too: never leave a service stopped
    s?.close();
    report.durationMs = Date.now() - started;
    report.incidentId = s?.incident?.id;
  }
  return report;
}

// ---------------------------------------------------------------- reporting
function markdown(reports) {
  const icon = { passed: '✅', failed: '❌', aborted: '⚠️', error: '💥' };
  const lines = [`# Game day: ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`, '', '| Experiment | Result | Hypothesis |', '|---|---|---|'];
  for (const r of reports) lines.push(`| \`${r.name}\` | ${icon[r.status]} ${r.status} | ${r.hypothesis} |`);
  for (const r of reports) {
    lines.push('', `## ${icon[r.status]} ${r.title}`, '', `**Faults:** ${r.faults.map((f) => `\`${target(f)}\` ${f.type}${f.ms ? ` ${f.ms} ms` : ''} from ${f.at}${f.seconds ? ` for ${f.seconds} s` : f.until ? ` until ${f.until}` : ''}`).join('; ')}`, '');
    if (r.abortReason) lines.push(`**Aborted:** ${r.abortReason}`, '');
    for (const c of r.checks) lines.push(`- ${c.ok ? '✅' : '❌'} \`${c.probe}\`${c.event ? ` ${c.event} → ${c.endpoint}` : ''} within ${c.withinSeconds} s: ${c.ok ? c.observed : `not observed${c.probe === 'timeline' ? ` (timeline: ${(r.timeline ?? []).join(' → ') || 'empty'})` : ''}`}`);
    if (r.replayed !== undefined) lines.push(`- replayed ${r.replayed} dead-lettered deliveries`);
    lines.push(`- duration ${(r.durationMs / 1000).toFixed(0)} s`);
  }
  return lines.join('\n') + '\n';
}

const only = process.argv.slice(2);
const files = readdirSync(`${here}experiments`).filter((f) => f.endsWith('.json')).sort();
const experiments = files.map((f) => JSON.parse(readFileSync(`${here}experiments/${f}`, 'utf8'))).filter((x) => !only.length || only.includes(x.name));
const p = await platform();
const reports = [];
for (const x of experiments) {
  process.stdout.write(`▶ ${x.name}: ${x.title} … `);
  const r = await runExperiment(p, x);
  reports.push(r);
  console.log(r.status.toUpperCase(), `(${(r.durationMs / 1000).toFixed(0)} s)`);
  for (const c of r.checks) console.log(`   ${c.ok ? '✓' : '✗'} ${c.probe}${c.event ? ` ${c.event}→${c.endpoint}` : ''}: ${c.ok ? c.observed : 'not observed'}`);
  if (r.abortReason) console.log(`   ! ${r.abortReason}`);
}
mkdirSync(`${here}reports`, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
writeFileSync(`${here}reports/${stamp}.json`, JSON.stringify(reports, null, 2));
writeFileSync(`${here}reports/latest.md`, markdown(reports));
writeFileSync(`${here}reports/latest.json`, JSON.stringify(reports, null, 2)); // versioned evidence; the console reads it
console.log(`\nReport: chaos/reports/latest.md (${reports.filter((r) => r.status === 'passed').length}/${reports.length} passed)`);
process.exit(reports.every((r) => r.status === 'passed') ? 0 : 1);
