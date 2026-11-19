import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeHandler } from '../src/handler.ts';
import { Counters, counterTotal } from '../src/metrics.ts';
import { parseOrder, totalCents } from '../src/orders.ts';

const valid = { customerId: 'cus_42', items: [{ sku: 'SKU-1', qty: 2, unitPriceCents: 1999 }, { sku: 'SKU-2', qty: 1, unitPriceCents: 500 }] };

test('validates orders and prices them in integer cents', () => {
  const parsed = parseOrder(valid);
  assert.ok(parsed.ok);
  assert.equal(totalCents(parsed.value), 4498);
  const bad = parseOrder({ customerId: 'a b', items: [{ sku: 'lower', qty: 0, unitPriceCents: 1.5 }] });
  assert.ok(!bad.ok);
  assert.equal(bad.errors.length, 4);
  assert.ok(!parseOrder(null).ok);
  assert.ok(!parseOrder({ customerId: 'c', items: [] }).ok);
});

test('the Lambda handler reports only the failed messages of a batch', async () => {
  const fulfilled: string[] = [];
  const handler = makeHandler(async (order) => { fulfilled.push(order.orderId); });
  const record = (id: string, body: unknown) => ({ messageId: id, body: typeof body === 'string' ? body : JSON.stringify(body) });
  const result = await handler({ Records: [
    record('m1', { ...valid, orderId: 'o1', createdAt: 'now' }),
    record('m2', 'not json'),
    record('m3', { ...valid, customerId: 'bad id', orderId: 'o3' }),
    record('m4', { ...valid }), // no orderId
    record('m5', { ...valid, orderId: 'o5', createdAt: 'now' }),
  ] });
  assert.deepEqual(fulfilled, ['o1', 'o5']);
  assert.deepEqual(result.batchItemFailures.map((f) => f.itemIdentifier), ['m2', 'm3', 'm4']);
});

test('metrics render as Prometheus text and can be read back', () => {
  const m = new Counters({ orders_total: 'orders', other_total: 'other' });
  m.inc('orders_total', { path: 'v1' });
  m.inc('orders_total', { path: 'v2' }, 3);
  const text = m.render();
  assert.match(text, /orders_total\{path="v2"\} 3/);
  assert.match(text, /other_total 0/);
  assert.equal(counterTotal(text, 'orders_total'), 4);
  assert.equal(counterTotal(text, 'missing_total'), 0);
});
