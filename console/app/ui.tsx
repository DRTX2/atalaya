import Link from 'next/link';
import type { LedgerIncident } from '@/lib/api';
import { duration } from '@/lib/timeline';

const STATUS: Record<LedgerIncident['status'], { tone: string; label: string }> = {
  open: { tone: 'bad', label: 'Open' },
  mitigated: { tone: 'warn', label: 'Mitigated' },
  recovered: { tone: 'ok', label: 'Recovered' },
};

export function StatusPill({ status }: { status: LedgerIncident['status'] }) {
  const s = STATUS[status];
  return <span className={`pill ${s.tone}`}><span className="dot" />{s.label}</span>;
}

/** One product being unreachable degrades its panel only; the rest of the page still renders. */
export function Unavailable({ error }: { error: string }) {
  return <div className="unavailable">⚠ {error}</div>;
}

export const when = (iso?: string) =>
  iso ? new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'UTC' }) + ' UTC' : '—';

export function IncidentTable({ incidents }: { incidents: LedgerIncident[] }) {
  if (!incidents.length) return <div className="empty">No incidents yet. Run <code>node demo.mjs</code> or a game day.</div>;
  return (
    <table>
      <thead>
        <tr><th>Status</th><th>Incident</th><th>Opened</th><th>Time to mitigate</th><th>Time to recover</th><th>Flag restored</th></tr>
      </thead>
      <tbody>
        {incidents.map((i) => (
          <tr key={i.incidentId} className="link">
            <td><StatusPill status={i.status} /></td>
            <td className="summary-cell">
              <Link href={`/incidents/${i.incidentId}`}>
                <strong>{i.summary ?? i.detector ?? i.incidentId}</strong>
                <span>{i.pipelineName ?? 'unknown pipeline'} · {i.detector}</span>
              </Link>
            </td>
            <td className="num muted">{when(i.openedAt)}</td>
            <td className="num">{i.mitigatedAt ? duration(i.timeToMitigateMs) : <span className="pill bad">not mitigated</span>}</td>
            <td className="num">{duration(i.timeToRecoverMs)}</td>
            <td className="num">{duration(i.timeToRestoreMs)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
