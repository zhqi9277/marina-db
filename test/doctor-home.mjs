// Doctor checks against an isolated MARINA_HOME: cache summary, writability and
// port-conflict reporting. No network and no real database.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'marina-doctor-'));
process.env.MARINA_HOME = HOME;

const { runDoctor } = await import('../src/doctor.js');
const { OS_LABEL } = await import('../src/platform.js');
const state = await import('../src/state.js');
const versions = await import('../src/versions.js');

const check = (checks, name) => {
  const item = checks.find((c) => c.name === name);
  assert.ok(item, `missing check ${name}`);
  return item;
};

after(() => fs.rmSync(HOME, { recursive: true, force: true }));

test('an empty home reports the expected check values', async () => {
  const checks = await runDoctor();
  assert.equal(checks.length, 7);

  assert.deepEqual(check(checks, 'platform'), { name: 'platform', value: `${OS_LABEL} ${process.arch}`, ok: true });
  assert.deepEqual(check(checks, 'node'), { name: 'node', value: process.versions.node, ok: true });
  assert.deepEqual(check(checks, 'MARINA_HOME'), { name: 'MARINA_HOME', value: HOME, ok: true });

  const tar = check(checks, 'tar');
  assert.equal(tar.ok, true);
  assert.ok(tar.value.length > 0);

  assert.deepEqual(check(checks, 'index'), {
    name: 'index',
    value: 'not fetched yet — run: marina remote --refresh',
    ok: false,
  });
  assert.match(check(checks, 'libs').value, /checked/);
  assert.equal(check(checks, 'libs').ok, true);
  assert.deepEqual(check(checks, 'ports'), { name: 'ports', value: 'no foreign listeners', ok: true });
});

test('a populated index cache turns the index check green', async () => {
  const file = versions._internal.cacheFile('mysql');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({
      engine: 'mysql',
      source: 'fixture',
      fetchedAt: Date.now(),
      versions: [{ version: '8.4.11', major: '8.4', kind: 'binary', urls: ['u'], platformKnown: true }],
    }) + '\n',
  );

  const index = check(await runDoctor(), 'index');
  assert.equal(index.ok, true);
  assert.match(index.value, /1 engines cached/);
  assert.match(index.value, /last refresh/);
});

test('a foreign listener on an installed engine port is reported as a conflict', async () => {
  const bin = path.join(HOME, 'engines', 'postgres', '17', '17.11', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  // package marker, plus a probe that fails without looking "broken"
  for (const [name, body] of [['postgres', '#!/bin/sh\nexit 0\n'], ['pg_isready', '#!/bin/sh\necho "no response"\nexit 2\n']]) {
    const file = path.join(bin, name);
    fs.writeFileSync(file, body);
    fs.chmodSync(file, 0o755);
  }

  const srv = net.createServer();
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const port = srv.address().port;
  state.setPort('postgres', '17', port);
  state.setActive('postgres', '17.11');

  try {
    const checks = await runDoctor();
    const ports = check(checks, 'ports');
    assert.equal(ports.ok, false);
    assert.equal(ports.value, `postgres port ${port}`);
    // the fake package still inspects cleanly
    assert.equal(check(checks, 'libs').ok, true);
  } finally {
    await new Promise((resolve) => srv.close(resolve));
  }

  // once the foreign listener is gone the check recovers
  const recovered = check(await runDoctor(), 'ports');
  assert.deepEqual(recovered, { name: 'ports', value: 'no foreign listeners', ok: true });
});
