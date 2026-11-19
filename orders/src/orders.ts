// Order validation and pricing: pure functions shared by the API (v1, synchronous) and the consumer (v2).
// Money is integer cents end to end; no floating point.

export interface OrderItem { sku: string; qty: number; unitPriceCents: number }
export interface Order { orderId: string; customerId: string; items: OrderItem[]; createdAt: string }

export type Parsed<T> = { ok: true; value: T } | { ok: false; errors: string[] };

const isInt = (v: unknown, min: number, max: number): v is number => Number.isInteger(v) && (v as number) >= min && (v as number) <= max;

export function parseOrder(input: unknown): Parsed<Omit<Order, 'orderId' | 'createdAt'>> {
  const errors: string[] = [];
  const body = (input ?? {}) as Record<string, unknown>;
  const customerId = body.customerId;
  if (typeof customerId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(customerId)) errors.push('customerId must be 1-64 letters, digits, - or _');
  const items = body.items;
  if (!Array.isArray(items) || items.length < 1 || items.length > 50) errors.push('items must contain 1-50 entries');
  else {
    items.forEach((raw, i) => {
      const it = (raw ?? {}) as Record<string, unknown>;
      if (typeof it.sku !== 'string' || !/^[A-Z0-9-]{1,32}$/.test(it.sku)) errors.push(`items[${i}].sku must be 1-32 uppercase letters, digits or -`);
      if (!isInt(it.qty, 1, 100)) errors.push(`items[${i}].qty must be an integer from 1 to 100`);
      if (!isInt(it.unitPriceCents, 0, 10_000_000)) errors.push(`items[${i}].unitPriceCents must be an integer from 0 to 10,000,000`);
    });
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, value: { customerId: customerId as string, items: (items as OrderItem[]).map(({ sku, qty, unitPriceCents }) => ({ sku, qty, unitPriceCents })) } };
}

export const totalCents = (order: Pick<Order, 'items'>) => order.items.reduce((sum, i) => sum + i.qty * i.unitPriceCents, 0);
