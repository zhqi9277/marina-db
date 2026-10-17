// Credential descriptors exposed by engine drivers.
import assert from 'node:assert/strict';
import test from 'node:test';
import mysql from '../src/engines/mysql.js';
import mariadb from '../src/engines/mariadb.js';
import postgres from '../src/engines/postgres.js';
import mongodb from '../src/engines/mongodb.js';
import redis from '../src/engines/redis.js';
import memcached from '../src/engines/memcached.js';

const ctx = { password: 'root' };

test('mysql family reports root with the configured password', () => {
  for (const engine of [mysql, mariadb]) {
    const a = engine.account(ctx);
    assert.equal(a.user, 'root');
    assert.equal(a.password, 'root');
    assert.equal(a.mode, 'password');
  }
});

test('postgres reports the trust user without a password', () => {
  const a = postgres.account(ctx);
  assert.equal(a.user, 'postgres');
  assert.equal(a.password, null);
  assert.equal(a.mode, 'trust');
});

test('engines without auth report no credentials', () => {
  for (const engine of [mongodb, redis, memcached]) {
    const a = engine.account(ctx);
    assert.equal(a.user, null);
    assert.equal(a.password, null);
    assert.equal(a.mode, 'disabled');
  }
});
