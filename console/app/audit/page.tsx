import Link from 'next/link';
import { connection } from 'next/server';
import { recent } from '@/lib/audit';
import { requireUser } from '@/lib/auth';
import { when } from '../ui';

const LABEL = { 'incident.acknowledge': 'Acknowledged incident', 'delivery.resend': 'Resent deliveries', 'flag.enable': 'Turned flag on', 'flag.disable': 'Turned flag off' };

export default async function AuditPage() {
  await connection();
  await requireUser();
  const entries = await recent();
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Audit log</h1>
          <p>Every action taken from the console, by the person signed in through SSO. Flagship&apos;s own audit names them too.</p>
        </div>
      </div>
      <section className="panel">
        {entries.length === 0 ? <div className="empty">No actions yet. Operators act from an incident&apos;s Respond panel.</div> : (
          <table>
            <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Target</th><th>Incident</th></tr></thead>
            <tbody>
              {entries.map((e, i) => (
                <tr key={i}>
                  <td>{when(e.at)}</td>
                  <td>{e.name} <span className={`role ${e.role}`}>{e.role}</span></td>
                  <td>{LABEL[e.action]}{e.detail ? <span className="muted"> · {e.detail}</span> : null}</td>
                  <td className="mono">{e.target.length > 40 ? `${e.target.slice(0, 40)}…` : e.target}</td>
                  <td><Link href={`/incidents/${e.incidentId}`} className="mono">{e.incidentId.slice(0, 8)}</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
