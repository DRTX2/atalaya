import Link from 'next/link';
import { deadLetterCount, deliveryStats, flags, latestGameDay, listIncidents, pipelines, settle } from '@/lib/api';
import { duration, percentiles } from '@/lib/timeline';
import { IncidentTable, Unavailable } from './ui';

export default async function Overview() {
  const [incidents, stats, dlq, flagList, watched, gameDay] = await Promise.all([
    settle(listIncidents(50)), settle(deliveryStats()), settle(deadLetterCount()), settle(flags()), settle(pipelines()), settle(latestGameDay()),
  ]);
  const items = incidents.ok ? incidents.value : [];
  const ttm = percentiles(items.filter((i) => i.mitigatedAt).map((i) => i.timeToMitigateMs!));
  const ttr = percentiles(items.filter((i) => i.recoveredAt).map((i) => i.timeToRecoverMs!));
  const open = items.filter((i) => i.status !== 'recovered').length;
  const unmitigated = items.filter((i) => !i.mitigatedAt).length;
  const gd = gameDay.ok ? gameDay.value : null;
  const passed = gd?.experiments.filter((x) => x.status === 'passed').length ?? 0;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Overview</h1>
          <p>Four independent products, one incident loop. Live from each product's API.</p>
        </div>
      </div>

      <section className="panel loop" aria-label="The incident loop">
        <div className="loop-step"><div className="verb">Detect</div><div className="who">Nimbus</div><div className="what">{watched.ok ? `${watched.value.length} pipelines watched` : 'unreachable'}</div></div>
        <div className="loop-step"><div className="verb">Mitigate</div><div className="who">Flagship</div><div className="what">{flagList.ok ? `${flagList.value.length} flags · kill switches` : 'unreachable'}</div></div>
        <div className="loop-step"><div className="verb">Notify</div><div className="who">Hookrelay</div><div className="what">{stats.ok ? `${stats.value.succeeded} deliveries, 24 h` : 'unreachable'}</div></div>
        <div className="loop-step"><div className="verb">Recover</div><div className="who">Nimbus + Flagship</div><div className="what">flag restored if nobody touched it</div></div>
        <div className="loop-step"><div className="verb">Learn</div><div className="who">Bitácora</div><div className="what">{incidents.ok ? `${items.length} postmortems` : 'unreachable'}</div></div>
      </section>

      <section className="grid kpis">
        <div className="panel kpi"><div className="label">Open incidents</div><div className="value">{incidents.ok ? open : '—'}</div><div className="hint">{unmitigated ? `${unmitigated} never mitigated` : 'all mitigated'}</div></div>
        <div className="panel kpi accent"><div className="label">Time to mitigate</div><div className="value">{duration(ttm.p50)}</div><div className="hint">median · p95 {duration(ttm.p95)}</div></div>
        <div className="panel kpi"><div className="label">Time to recover</div><div className="value">{duration(ttr.p50)}</div><div className="hint">median · p95 {duration(ttr.p95)}</div></div>
        <div className="panel kpi"><div className="label">Webhook success, 24 h</div><div className="value">{stats.ok && stats.value.successRate !== null ? `${(stats.value.successRate * 100).toFixed(1)}%` : '—'}</div><div className="hint">{stats.ok ? `p95 ${stats.value.p95 ?? '—'} ms` : 'Hookrelay unreachable'}</div></div>
        <div className="panel kpi"><div className="label">Dead letters</div><div className="value">{dlq.ok ? dlq.value : '—'}</div><div className="hint">waiting for replay</div></div>
        <div className="panel kpi"><div className="label">Last game day</div><div className="value">{gd ? `${passed}/${gd.experiments.length}` : '—'}</div><div className="hint">{gd ? <Link href="/game-days">experiments passed →</Link> : 'none yet: node chaos/run.mjs'}</div></div>
      </section>

      <section className="panel">
        <div className="panel-head"><h2>Recent incidents</h2><Link href="/incidents" className="muted">All incidents →</Link></div>
        {incidents.ok ? <IncidentTable incidents={items.slice(0, 8)} /> : <Unavailable error={incidents.error} />}
      </section>
    </>
  );
}
