// Pure authorization rules, shared by pages and server actions (unit-tested in test/roles.test.ts).

export type Role = 'operator' | 'viewer';
export interface User { username: string; name: string; role: Role }

/** Highest console role among the identity provider's roles; null means signed in but not allowed. */
export function roleOf(roles: unknown): Role | null {
  const list = Array.isArray(roles) ? roles : [];
  if (list.includes('operator')) return 'operator';
  if (list.includes('viewer')) return 'viewer';
  return null;
}

export const canAct = (user: User | null): boolean => user?.role === 'operator';

// Inputs to server actions come from the browser: validate before they reach a product API.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY = /^[a-z0-9][a-z0-9._-]{0,199}$/i;
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);
export const isKey = (v: unknown): v is string => typeof v === 'string' && KEY.test(v);

/** A same-site path to come back to after login; anything else (another origin, //host) becomes "/". */
export const safeReturnTo = (v: unknown): string => (typeof v === 'string' && v.startsWith('/') && !v.startsWith('//') && !v.includes('\\') ? v : '/');
