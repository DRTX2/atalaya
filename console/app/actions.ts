'use server';
import { revalidatePath } from 'next/cache';
import { unstable_rethrow } from 'next/navigation';
import { acknowledgeIncident, flagEnv, resendDelivery, setFlagEnabled } from '@/lib/api';
import { record } from '@/lib/audit';
import { currentUser } from '@/lib/auth';
import { canAct, isKey, isUuid } from '@/lib/roles';

export type ActionResult = { ok: boolean; message: string } | null;

// Every action: authorize on the server (the disabled button is only a hint), validate the input,
// call the product with the person's name where the product records one, and audit the outcome.
async function act(incidentId: unknown, run: (user: NonNullable<Awaited<ReturnType<typeof currentUser>>>) => Promise<{ audit: Parameters<typeof record>[1]; message: string }>): Promise<ActionResult> {
  const user = await currentUser();
  if (!canAct(user)) return { ok: false, message: 'Only operators can do this.' };
  if (!isUuid(incidentId)) return { ok: false, message: 'Invalid incident.' };
  try {
    const { audit, message } = await run(user!);
    await record(user!, audit);
    revalidatePath(`/incidents/${incidentId}`);
    return { ok: true, message };
  } catch (e) {
    unstable_rethrow(e);
    return { ok: false, message: (e as Error).message };
  }
}

export async function acknowledge(incidentId: string, _: ActionResult): Promise<ActionResult> {
  return act(incidentId, async () => {
    await acknowledgeIncident(incidentId);
    return { audit: { action: 'incident.acknowledge', target: incidentId, incidentId, outcome: 'ok' }, message: 'Acknowledged in Nimbus.' };
  });
}

export async function resend(incidentId: string, deliveryIds: string[], _: ActionResult): Promise<ActionResult> {
  return act(incidentId, async () => {
    if (!deliveryIds.length || !deliveryIds.every(isUuid)) throw new Error('Invalid deliveries.');
    await Promise.all(deliveryIds.map(resendDelivery));
    return { audit: { action: 'delivery.resend', target: deliveryIds.join(','), incidentId, outcome: 'ok', detail: `${deliveryIds.length} delivery(ies)` }, message: `Resending ${deliveryIds.length} delivery(ies) through Hookrelay.` };
  });
}

export async function toggleFlag(incidentId: string, flagKey: string, env: string, enabled: boolean, _: ActionResult): Promise<ActionResult> {
  return act(incidentId, async (user) => {
    if (!isKey(flagKey) || !isKey(env) || typeof enabled !== 'boolean') throw new Error('Invalid flag.');
    const current = await flagEnv(flagKey, env);
    if (current.enabled === enabled) throw new Error(`${flagKey} is already ${enabled ? 'on' : 'off'}.`);
    await setFlagEnabled(flagKey, env, { ...current, enabled }, `${user.name} (${user.username}) via Atalaya Console`);
    return { audit: { action: enabled ? 'flag.enable' : 'flag.disable', target: `${flagKey}@${env}`, incidentId, outcome: 'ok' }, message: `${flagKey} turned ${enabled ? 'on' : 'off'} in ${env}.` };
  });
}
