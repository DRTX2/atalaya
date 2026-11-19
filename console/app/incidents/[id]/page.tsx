import Link from 'next/link';
import { notFound } from 'next/navigation';
import { flagAudit, flagEnv, incidentMessages, ledger, nimbusIncident, postmortem, settle, traceUrl } from '@/lib/api';
import { currentUser } from '@/lib/auth';
import { canAct } from '@/lib/roles';
import { acknowledge, resend, toggleFlag } from '../../actions';
import { ActionButton } from '../../action-button';
import { renderMarkdown } from '@/lib/markdown';
import { buildTimeline, duration, endpointName } from '@/lib/timeline';
import { StatusPill, Unavailable, when } from '../../ui';

const relative = (at: string, origin?: string) => {
  if (!origin) return '';
  const ms = Date.parse(at) - Date.parse(origin);
  if (Math.abs(ms) >= 60_000) return `${ms < 0 ? '−' : '+'}${Math.round(Math.abs(ms) / 60_000)}m`;
  return `${ms < 0 ? '−' : '+'}${(Math.abs(ms) / 1000).toFixed(1)}s`;
};

export default async function IncidentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const record = await settle(ledger(id));
  if (!record.ok) {
    if (record.error.includes('404') || record.error.includes('Not Found')) notFound();
  }
  const [nimbus, messages, markdown] = await Promise.all([settle(nimbusIncident(id)), settle(incidentMessages(id)), settle(postmortem(id))]);
  const incident = record.ok ? record.value.incident : undefined;
  const metrics = record.ok ? record.value.metrics : undefined;
  const flagKeys = (incident?.flags ?? []).map((f) => f.split('@')[0]);
  const audits = await Promise.all(flagKeys.map(async (flag) => ({ flag, result: await settle(flagAudit(flag)) })));
  const user = await currentUser();
  const operator = canAct(user);
  const flagStates = await Promise.all((incident?.flags ?? []).map(async (f) => {
    const [key, env = 'production'] = f.split('@');
    return { key, env, state: await settle(flagEnv(key, env)) };
  }));
  const failed = messages.ok ? messages.value.flatMap((m) => m.deliveries.filter((d) => d.status === 'failed').map((d) => d.id)) : [];
  const onlyOperators = operator ? undefined : 'Operators only';

  const events = buildTimeline({
    nimbus: nimbus.ok ? nimbus.value : undefined,
    audit: audits.filter((a) => a.result.ok).map((a) => ({ flag: a.flag, entries: a.result.ok ? a.result.value : [] })),
    messages: messages.ok ? messages.value : [],
    ledger: incident,
  });
  const origin = nimbus.ok ? nimbus.value.openedAt : incident?.openedAt;
  const unavailable = [nimbus, messages, ...audits.map((a) => a.result)].filter((r) => !r.ok).map((r) => (r.ok ? '' : r.error));
  const title = (nimbus.ok ? nimbus.value.summary : incident?.summary) ?? id;

  return (
    <>
      <Link href="/incidents" className="back">← Incidents</Link>
      <div className="page-head">
        <div>
          <h1>{title}</h1>
          <p>
            {(nimbus.ok ? nimbus.value.pipelineName : incident?.pipelineName) ?? 'unknown pipeline'} · <code>{nimbus.ok ? nimbus.value.detector : incident?.detector}</code> · opened {when(origin)} · <code>{id}</code>
          </p>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          {nimbus.ok && <span className={`pill ${nimbus.value.severity === 'critical' ? 'bad' : 'warn'}`}>{nimbus.value.severity}</span>}
          {incident && <StatusPill status={metrics!.status} />}
          <a className="pill neutral" href={traceUrl(id)} target="_blank" rel="noreferrer" title="Every product's spans for this incident, in Jaeger">View trace ↗</a>
        </div>
      </div>

      <section className="grid kpis">
        <div className="panel kpi accent"><div className="label">Time to mitigate</div><div className="value">{incident?.mitigatedAt ? duration(metrics?.timeToMitigateMs) : 'not mitigated'}</div><div className="hint">opened → flag off</div></div>
        <div className="panel kpi"><div className="label">Time to recover</div><div className="value">{duration(metrics?.timeToRecoverMs)}</div><div className="hint">opened → healthy windows</div></div>
        <div className="panel kpi"><div className="label">Flag restored</div><div className="value">{duration(metrics?.timeToRestoreMs)}</div><div className="hint">after recovery</div></div>
        <div className="panel kpi"><div className="label">Flags killed</div><div className="value">{incident?.flags.length ?? '—'}</div><div className="hint mono">{incident?.flags.join(', ') || '—'}</div></div>
      </section>

      <div className="grid two">
        <section className="panel">
          <div className="panel-head">
            <h2>Timeline across products</h2>
            <span style={{ display: 'flex', gap: '0.35rem' }}>
              {(['nimbus', 'flagship', 'hookrelay'] as const).map((p) => <span key={p} className={`product ${p}`}>{p}</span>)}
            </span>
          </div>
          {unavailable.map((e) => <Unavailable key={e} error={e} />)}
          <ol className="timeline">
            {events.map((e, i) => (
              <li key={i}>
                <span className="when" title={when(e.at)}>{relative(e.at, origin)}</span>
                <span className={`rail tone-${e.tone}`}><span className="node" /></span>
                <span className="what"><span className={`product ${e.product}`}>{e.product}</span><strong>{e.title}</strong></span>
                {e.detail && <span className="detail">{e.detail}</span>}
              </li>
            ))}
          </ol>
        </section>

        <div className="stack">
          <section className="panel" aria-labelledby="respond">
            <div className="panel-head"><h2 id="respond">Respond</h2><span className="muted small">{operator ? `as ${user!.name}` : `${user?.name ?? 'viewer'} · read-only`}</span></div>
            <div className="panel-body actions">
              <ActionButton action={acknowledge.bind(null, id)} label="Acknowledge" disabled={!operator || !nimbus.ok || nimbus.value.status !== 'open'} title={onlyOperators ?? (nimbus.ok && nimbus.value.status !== 'open' ? `Already ${nimbus.value.status}` : undefined)} />
              {flagStates.map(({ key, env, state }) => state.ok && (
                <ActionButton key={key + env} action={toggleFlag.bind(null, id, key, env, !state.value.enabled)} tone={state.value.enabled ? 'danger' : undefined}
                  label={`${state.value.enabled ? 'Turn off' : 'Turn on'} ${key}`} disabled={!operator} title={onlyOperators ?? `${key} is ${state.value.enabled ? 'on' : 'off'} in ${env}`} />
              ))}
              {failed.length > 0 && <ActionButton action={resend.bind(null, id, failed)} label={`Resend ${failed.length} failed deliver${failed.length > 1 ? 'ies' : 'y'}`} disabled={!operator} title={onlyOperators} />}
              {!operator && <p className="muted small">Signed in as a viewer: actions need the operator role.</p>}
              <p className="muted small">Every action is recorded in the <a href="/audit">audit log</a> with your name.</p>
            </div>
          </section>
          {nimbus.ok && nimbus.value.evidence && (
            <section className="panel">
              <div className="panel-head"><h2>Evidence</h2><span className="product nimbus">nimbus</span></div>
              <div className="panel-body">
                <dl className="facts">
                  <dt>Window</dt><dd>{when(nimbus.value.evidence.windowStartedAt)} → {new Date(nimbus.value.evidence.windowEndedAt).toISOString().slice(11, 16)} UTC</dd>
                  <dt>Queue backlog</dt><dd>{nimbus.value.evidence.visibleMessages} messages</dd>
                  <dt>Oldest message</dt><dd>{Math.round(nimbus.value.evidence.oldestMessageSeconds / 60)} min</dd>
                  <dt>Consumer invocations</dt><dd>{nimbus.value.evidence.lambdaInvocations}</dd>
                  <dt>Errors · DLQ</dt><dd>{nimbus.value.evidence.lambdaErrors} · {nimbus.value.evidence.dlqMessages}</dd>
                </dl>
              </div>
            </section>
          )}
          {messages.ok && (
            <section className="panel">
              <div className="panel-head"><h2>Notifications</h2><span className="product hookrelay">hookrelay</span></div>
              <table>
                <thead><tr><th>Event</th><th>Endpoint</th><th>Attempts</th><th>Result</th></tr></thead>
                <tbody>
                  {messages.value.flatMap((m) => m.deliveries.map((d) => (
                    <tr key={m.id + d.endpointUrl}>
                      <td className="mono">{m.eventType.replace('incident.', '')}</td>
                      <td>{endpointName(d.endpointUrl)}</td>
                      <td className="num">{d.attempts.length}</td>
                      <td><span className={`pill ${d.status === 'succeeded' ? 'ok' : d.status === 'failed' ? 'bad' : 'warn'}`}>{d.status === 'failed' ? 'in DLQ' : d.status}</span></td>
                    </tr>
                  )))}
                </tbody>
              </table>
            </section>
          )}
        </div>
      </div>

      <section className="panel" style={{ marginTop: '1rem' }}>
        <div className="panel-head"><h2>Postmortem draft</h2><span className="product bitacora">bitácora</span></div>
        {markdown.ok ? <div className="prose" dangerouslySetInnerHTML={{ __html: renderMarkdown(markdown.value) }} /> : <Unavailable error={markdown.error} />}
      </section>
    </>
  );
}

