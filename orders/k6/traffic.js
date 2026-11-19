// Steady customer traffic against the orders API: 10 orders/s for hours (stopped with the stack).
import http from 'k6/http';
import { check } from 'k6';

export const options = {
  scenarios: { customers: { executor: 'constant-arrival-rate', rate: Number(__ENV.RATE || 10), timeUnit: '1s', duration: __ENV.DURATION || '6h', preAllocatedVUs: 20, maxVUs: 100 } },
  summaryTrendStats: ['p(50)', 'p(95)', 'p(99)'],
  dns: { ttl: '0' }, // follow the orders container when it restarts (a cached IP silently fails every request)
};
const SKUS = ['SKU-1', 'SKU-2', 'SKU-3', 'SKU-4', 'SKU-5'];

export default function () {
  const items = Array.from({ length: 1 + Math.floor(Math.random() * 3) }, () => ({ sku: SKUS[Math.floor(Math.random() * SKUS.length)], qty: 1 + Math.floor(Math.random() * 3), unitPriceCents: 500 + Math.floor(Math.random() * 5000) }));
  const res = http.post(`${__ENV.BASE_URL}/orders`, JSON.stringify({ customerId: `cus_${Math.floor(Math.random() * 5000)}`, items }), { headers: { 'content-type': 'application/json' }, tags: { name: 'POST /orders' } });
  check(res, { 'order accepted': (r) => r.status === 201 || r.status === 202 });
}
