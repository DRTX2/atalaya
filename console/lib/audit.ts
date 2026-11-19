import 'server-only';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { User } from './roles';

// Who did what from the console. Products record the action too (Flagship's audit names the person
// through x-actor; Nimbus and Hookrelay see the console's service credential), so this log is what
// ties each action to the person signed in through SSO.
// shortcut: append-only JSONL on one volume, fine for a single console replica; move it to a table
// (or ship it to the products' audit APIs) before running several replicas.
export interface AuditEntry {
  at: string; actor: string; name: string; role: string;
  action: 'incident.acknowledge' | 'delivery.resend' | 'flag.enable' | 'flag.disable';
  target: string; incidentId: string; outcome: 'ok' | 'failed'; detail?: string;
}

const file = () => join(process.env.AUDIT_DIR ?? './data', 'audit.jsonl');

export async function record(user: User, entry: Omit<AuditEntry, 'at' | 'actor' | 'name' | 'role'>): Promise<void> {
  const line: AuditEntry = { at: new Date().toISOString(), actor: user.username, name: user.name, role: user.role, ...entry };
  await mkdir(process.env.AUDIT_DIR ?? './data', { recursive: true });
  await appendFile(file(), JSON.stringify(line) + '\n');
}

export async function recent(limit = 100): Promise<AuditEntry[]> {
  const text = await readFile(file(), 'utf8').catch(() => '');
  return text.split('\n').filter(Boolean).map((l) => JSON.parse(l) as AuditEntry).reverse().slice(0, limit);
}
