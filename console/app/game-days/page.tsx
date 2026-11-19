import { latestGameDay, settle } from '@/lib/api';
import { duration } from '@/lib/timeline';
import { Unavailable } from '../ui';

const TONE: Record<string, string> = { passed: 'ok', failed: 'bad', aborted: 'warn', error: 'bad' };

export default async function GameDays() {
  const report = await settle(latestGameDay());
  const gd = report.ok ? report.value : null;
  const passed = gd?.experiments.filter((x) => x.status === 'passed').length ?? 0;
  const ranAt = gd?.file.replace(/\.json$/, '').replace(/T(\d\d)-(\d\d)-(\d\d)$/, ' $1:$2 UTC');

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Game days</h1>
          <p>Each failure mode in the architecture is an experiment: break one link between products, verify the claim with real data, always heal.</p>
        </div>
        {gd && <span className={`pill ${passed === gd.experiments.length ? 'ok' : 'bad'}`}>{passed}/{gd.experiments.length} passed · {ranAt}</span>}
      </div>

      {!report.ok && <section className="panel"><Unavailable error={report.error} /></section>}
      {report.ok && !gd && <section className="panel"><div className="empty">No game day yet. Run <code>node chaos/run.mjs</code>.</div></section>}

      {gd && (
        <section className="grid experiments">
          {gd.experiments.map((x) => (
            <article key={x.name} className="panel experiment">
              <div className="panel-head">
                <h2>{x.title}</h2>
                <span className={`pill ${TONE[x.status] ?? 'neutral'}`}>{x.status}</span>
              </div>
              <div className="panel-body">
                <p className="hyp">{x.hypothesis}</p>
                <div className="faults">
                  {x.faults.map((f, i) => (
                    <span key={i} className="chip">
                      <code>{f.link}</code> {f.type}{f.ms ? ` +${f.ms} ms` : ''} · from {f.at}{f.seconds ? ` for ${f.seconds} s` : f.until ? ` until ${f.until}` : ''}
                    </span>
                  ))}
                  <span className="chip">{duration(x.durationMs)}</span>
                </div>
                {x.abortReason && <p className="muted">Aborted: {x.abortReason}</p>}
                <ul className="checks">
                  {x.checks.map((c, i) => (
                    <li key={i}>
                      <span className={c.ok ? 'tone-ok' : 'tone-bad'}>{c.ok ? '✓' : '✗'}</span>
                      <span>
                        <code>{c.probe}</code>{c.event ? ` ${c.event} → ${c.endpoint}` : ''} <span className="muted">within {c.withinSeconds} s</span>
                        <div className="obs">{c.ok ? c.observed : 'not observed'}</div>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </article>
          ))}
        </section>
      )}
    </>
  );
}
