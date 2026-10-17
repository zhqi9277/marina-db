// Inventory queries shared by the CLI and the TUI: rows, engine aggregation,
// and the "inactive sibling in the same major" annotation. Offline: a loopback
// listener stands in for a running server.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'marina-inventory-'));
process.env.MARINA_HOME = HOME;

const { engines } = await import('../src/registry.js');
const state = await import('../src/state.js');
const { collectRows, collectEngines, versionStatus } = await import('../src/inventory.js');

const versionPath = (key, major, version) => path.join(HOME, 'engines', key, major, version);
for (const [major, version] of [['8.0', '8.0.29'], ['8.4', '8.4.9'], ['8.4', '8.4.11']]) {
  fs.mkdirSync(versionPath('mysql', major, version), { recursive: true });
}

async function closedPort() {
  const srv = net.createServer();
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const { port } = srv.address();
  await new Promise((resolve) => srv.close(resolve));
  return port;
}

// one mysql major line is "served" by a loopback listener (no real database)
const listener = net.createServer();
await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
const livePort = listener.address().port;
state.setPort('mysql', '8.4', livePort);
state.setPort('mysql', '8.0', await closedPort());
state.setActive('mysql', '8.4.9');

after(async () => {
  await new Promise((resolve) => listener.close(resolve));
  fs.rmSync(HOME, { recursive: true, force: true });
});

test('versionStatus marks a non-active version of a running major as inactive', async () => {
  const st = await versionStatus(engines.mysql, { major: '8.4', version: '8.4.11' }, { major: '8.4', version: '8.4.9' });
  assert.equal(st.version, '8.4.11');
  assert.equal(st.active, false);
  assert.equal(st.pid, null);
  assert.equal(st.state, 'inactive');
});

test('versionStatus mirrors a stopped sibling state instead of inventing inactive', async () => {
  state.setPort('postgres', '17', await closedPort());
  const st = await versionStatus(engines.postgres, { major: '17', version: '17.11' }, { major: '17', version: '17.10' });
  assert.equal(st.active, false);
  assert.equal(st.state, 'stopped');
});

test('collectRows returns one enriched row per installed version', async () => {
  const rows = await collectRows();
  assert.deepEqual(rows.map((r) => r.version), ['8.0.29', '8.4.9', '8.4.11']);

  const byVersion = new Map(rows.map((r) => [r.version, r]));
  const active = byVersion.get('8.4.9');
  assert.equal(active.active, true);
  assert.equal(active.state, 'running');
  assert.equal(active.pid, null);
  assert.equal(active.label, 'MySQL');
  assert.equal(active.major, '8.4');
  assert.equal(active.engine.key, 'mysql');
  assert.equal(active.ctx.port, livePort);

  const sibling = byVersion.get('8.4.11');
  assert.equal(sibling.active, false);
  assert.equal(sibling.state, 'inactive');

  const otherMajor = byVersion.get('8.0.29');
  assert.equal(otherMajor.active, false);
  assert.equal(otherMajor.state, 'stopped');
});

test('collectEngines aggregates one row per engine and reports absent engines', async () => {
  const rows = await collectEngines();
  assert.equal(rows.length, 6);

  const mysql = rows.find((r) => r.key === 'mysql');
  assert.deepEqual(mysql.installed, ['8.0.29', '8.4.9', '8.4.11']);
  assert.equal(mysql.version, '8.4.9');
  assert.equal(mysql.major, '8.4');
  assert.equal(mysql.state, 'running');
  assert.equal(mysql.port, livePort);
  assert.equal(mysql.row.version, '8.4.9');

  const redis = rows.find((r) => r.key === 'redis');
  assert.deepEqual(redis.installed, []);
  assert.equal(redis.row, null);
  assert.equal(redis.version, null);
  assert.equal(redis.major, null);
  assert.equal(redis.ctx, null);
  assert.equal(redis.state, 'absent');
  assert.equal(redis.port, 6379);
});
