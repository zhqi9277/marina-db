// PostgreSQL driver: broken probe tools must not look like a dead server,
// and stale postmaster.pid files must be cleaned without touching live ones.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import postgres from '../src/engines/postgres.js';

const posix = process.platform !== 'win32';

function fakeRoot(script) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'marina-pg-'));
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  const file = path.join(bin, 'pg_isready');
  fs.writeFileSync(file, script);
  fs.chmodSync(file, 0o755);
  return root;
}

test('probe returns null when the probe tool itself is broken', { skip: !posix }, async () => {
  const root = fakeRoot('#!/bin/sh\necho "dyld: Library not loaded: /old/lib/libpq.5.dylib" >&2\nexit 134\n');
  const verdict = await postgres.probe({ root, port: 5432 });
  assert.equal(verdict, null); // unknown -> lifecycle falls back to TCP
});

test('probe returns false when the server is simply not accepting', { skip: !posix }, async () => {
  const root = fakeRoot('#!/bin/sh\necho "no response"\nexit 2\n');
  const verdict = await postgres.probe({ root, port: 5432 });
  assert.equal(verdict, false);
});

test('cleanRuntime removes a stale postmaster.pid', { skip: !posix }, () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'marina-pgdata-'));
  const file = path.join(dataDir, 'postmaster.pid');
  fs.writeFileSync(file, '999999\n/some/old/data\n');
  postgres.cleanRuntime({ dataDir });
  assert.equal(fs.existsSync(file), false);
});

test('cleanRuntime keeps the pid file of a live postmaster', { skip: !posix }, () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'marina-pgdata-'));
  const file = path.join(dataDir, 'postmaster.pid');
  fs.writeFileSync(file, `${process.pid}\n/some/data\n`);
  postgres.cleanRuntime({ dataDir });
  assert.equal(fs.existsSync(file), true);
});
