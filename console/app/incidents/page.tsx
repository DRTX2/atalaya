import { listIncidents, settle } from '@/lib/api';
import { IncidentTable, Unavailable } from '../ui';

export default async function Incidents() {
  const incidents = await settle(listIncidents(100));
  const items = incidents.ok ? incidents.value : [];
  const count = (s: string) => items.filter((i) => i.status === s).length;
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Incidents</h1>
          <p>Every incident Bitácora rebuilt from the webhooks, newest first.</p>
        </div>
        {incidents.ok && (
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <span className="chip">{items.length} total</span>
            <span className="chip">{count('open') + count('mitigated')} open</span>
            <span className="chip">{items.filter((i) => !i.mitigatedAt).length} never mitigated</span>
          </div>
        )}
      </div>
      <section className="panel">{incidents.ok ? <IncidentTable incidents={items} /> : <Unavailable error={incidents.error} />}</section>
    </>
  );
}
