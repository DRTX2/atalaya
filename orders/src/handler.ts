// The v2 consumer, written as an AWS Lambda SQS handler (the same code deploys to Lambda with
// ReportBatchItemFailures). Locally, consumer-local.ts long-polls the queue and calls it.
import { parseOrder, totalCents, type Order } from './orders.ts';

export interface SQSRecord { messageId: string; body: string }
export interface SQSEvent { Records: SQSRecord[] }
/** Lambda partial batch response: only the failed messages return to the queue (and, after maxReceiveCount, the DLQ). */
export interface BatchResponse { batchItemFailures: { itemIdentifier: string }[] }

export function makeHandler(fulfil: (order: Order, totalCents: number) => Promise<void>) {
  return async (event: SQSEvent): Promise<BatchResponse> => {
    const failures: { itemIdentifier: string }[] = [];
    for (const record of event.Records) {
      try {
        const message = JSON.parse(record.body) as Order;
        const parsed = parseOrder(message);
        if (!parsed.ok || typeof message.orderId !== 'string') throw new Error(`invalid order: ${parsed.ok ? 'missing orderId' : parsed.errors.join('; ')}`);
        await fulfil(message, totalCents(message));
      } catch {
        failures.push({ itemIdentifier: record.messageId });
      }
    }
    return { batchItemFailures: failures };
  };
}

// Lambda entry point: fulfilment here is simulated work (payment capture, stock reservation).
const workMs = Number(process.env.WORK_MS ?? 15);
export const handler = makeHandler(async () => { await new Promise((r) => setTimeout(r, workMs)); });
