import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canAct, isKey, isUuid, roleOf, safeReturnTo } from '../lib/roles.ts';

test('maps identity-provider roles to the highest console role', () => {
  assert.equal(roleOf(['viewer', 'operator', 'offline_access']), 'operator');
  assert.equal(roleOf(['viewer']), 'viewer');
  assert.equal(roleOf(['offline_access']), null);
  assert.equal(roleOf(undefined), null);
  assert.equal(roleOf('operator'), null); // a string is not a role list
});

test('only operators act', () => {
  assert.equal(canAct({ username: 'o', name: 'O', role: 'operator' }), true);
  assert.equal(canAct({ username: 'v', name: 'V', role: 'viewer' }), false);
  assert.equal(canAct(null), false);
});

test('validates what the browser sends to server actions', () => {
  assert.ok(isUuid('60a371f0-acb3-4c8e-95d2-f1143edd5ab8'));
  assert.ok(!isUuid('60a371f0; DROP'));
  assert.ok(isKey('checkout-v2') && isKey('production'));
  assert.ok(!isKey('../admin') && !isKey('') && !isKey(42));
});

test('only returns to same-site paths after login', () => {
  assert.equal(safeReturnTo('/incidents/abc'), '/incidents/abc');
  assert.equal(safeReturnTo('//evil.example'), '/');
  assert.equal(safeReturnTo('https://evil.example'), '/');
  assert.equal(safeReturnTo('/\\evil.example'), '/');
  assert.equal(safeReturnTo(null), '/');
});
