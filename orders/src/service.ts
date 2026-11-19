// Orders API. Checkout v2 is asynchronous (SQS + consumer) and guarded by the Flagship kill switch
// `checkout-v2`; when it is off (or the flag is unknown), orders take the synchronous v1 path.
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import { SendMessageCommand } from '@aws-sdk/client-sqs';
import { FlagshipClient } from '@flagship/sdk';
import { env, queueUrl, secret, sqs } from './config.ts';
import { Counters } from './metrics.ts';
import { parseOrder, totalCents } from './orders.ts';

const FLAG = 'checkout-v2';
const metrics = new Counters({
  orders_total: 'Orders accepted, by checkout path (v1 sync, v2 async) and result',
  checkout_v2_fallbacks_total: 'v2 orders served by v1 because the queue was unreachable',
});

const flags = await FlagshipClient.init({ sdkKey: secret('FLAGSHIP_SDK_KEY'), baseUrl: env('FLAGSHIP_URL'), initTimeoutMs: 5000 });
const ordersQueue = await queueUrl(env('ORDERS_QUEUE', 'orders'));

async function readJson(req: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 64 * 1024) throw Object.assign(new Error('body too large'), { status: 413 });
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw Object.assign(new Error('body is not JSON'), { status: 400 });
  }
}

const server = createServer(async (req, res) => {
  const send = (status: number, body: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  try {
    if (req.method === 'GET' && req.url === '/health') return send(200, { ok: true, flagsReady: flags.initialized });
    if (req.method === 'GET' && req.url === '/metrics') return res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' }).end(metrics.render());
    if (req.method !== 'POST' || req.url !== '/orders') return send(404, { error: 'not found' });

    const parsed = parseOrder(await readJson(req));
    if (!parsed.ok) return send(400, { errors: parsed.errors });
    const order = { ...parsed.value, orderId: randomUUID(), createdAt: new Date().toISOString() };

    // Local, synchronous evaluation: no network call per request, and the last known rules survive a Flagship outage.
    if (flags.variation(FLAG, { key: order.customerId }, false)) {
      try {
        await sqs.send(new SendMessageCommand({ QueueUrl: ordersQueue, MessageBody: JSON.stringify(order) }));
        metrics.inc('orders_total', { path: 'v2', result: 'queued' });
        return send(202, { orderId: order.orderId, path: 'v2', status: 'queued' });
      } catch {
        metrics.inc('checkout_v2_fallbacks_total'); // queue unreachable: never fail the customer, use v1
      }
    }
    metrics.inc('orders_total', { path: 'v1', result: 'confirmed' });
    return send(201, { orderId: order.orderId, path: 'v1', status: 'confirmed', totalCents: totalCents(order) });
  } catch (e) {
    const status = (e as { status?: number }).status ?? 500;
    if (status === 500) metrics.inc('orders_total', { path: 'none', result: 'failed' });
    return send(status, { error: (e as Error).message });
  }
});

server.listen(Number(env('PORT', '8081')), () => console.log(`orders listening on :${env('PORT', '8081')}`));
