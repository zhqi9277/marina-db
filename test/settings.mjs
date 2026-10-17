// Per-engine account resolution and settings validation.
import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveAccount } from '../src/state.js';
import { validatePort } from '../src/settings.js';

test('default accounts per engine', () => {
  assert.deepEqual(resolveAccount({ mysqlRootPassword: 'root' }, 'mysql'), { user: 'root', password: 'root' });
  assert.deepEqual(resolveAccount({ mysqlRootPassword: 'root' }, 'mariadb'), { user: 'root', password: 'root' });
  assert.deepEqual(resolveAccount({}, 'postgres'), { user: 'postgres', password: null });
  assert.deepEqual(resolveAccount({}, 'redis'), { user: null, password: null });
});

test('saved accounts override defaults', () => {
  const settings = { accounts: { mysql: { user: 'admin', password: 's3cret' } } };
  assert.deepEqual(resolveAccount(settings, 'mysql'), { user: 'admin', password: 's3cret' });
  // mariadb keeps its own default
  assert.deepEqual(resolveAccount(settings, 'mariadb'), { user: 'root', password: 'root' });
});

test('ports are validated', () => {
  assert.equal(validatePort(3306), 3306);
  assert.equal(validatePort('5432'), 5432);
  for (const bad of [0, -1, 65536, 'abc', 3.5]) {
    assert.throws(() => validatePort(bad), /1\.\.65535/);
  }
});
