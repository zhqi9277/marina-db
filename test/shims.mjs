// PATH shims: generation, installation into runtime/shims, and shellenv output.
// Uses a fake installed redis tree in an isolated MARINA_HOME; nothing is run.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'marina-shims-'));
process.env.MARINA_HOME = HOME;

const { engines } = await import('../src/registry.js');
const state = await import('../src/state.js');
const { dirs } = await import('../src/paths.js');
const { shimScript, installShims, resolveBin, shellenv } = await import('../src/shims.js');
const { IS_WIN } = await import('../src/platform.js');

const root = path.join(HOME, 'engines', 'redis', '7', '7.4.11');
fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
// redis-server is the discovery marker; redis-cli is the client we expect a shim for
for (const name of ['redis-server', 'redis-cli']) {
  const file = path.join(root, 'bin', name);
  fs.writeFileSync(file, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(file, 0o755);
}
state.setActive('redis', '7.4.11');

const posix = !IS_WIN;

after(() => fs.rmSync(HOME, { recursive: true, force: true }));

test('resolveBin maps a client binary to the active engine root', () => {
  const hit = resolveBin('redis-cli');
  assert.ok(hit);
  assert.equal(hit.engine.key, 'redis');
  assert.equal(hit.ctx.version, '7.4.11');
  assert.equal(hit.path, path.join(root, 'bin', 'redis-cli'));

  // not a managed client binary
  assert.equal(resolveBin('not-a-marina-binary'), null);
  // managed client of an engine with no installed version
  assert.equal(resolveBin('psql'), null);
});

test('installShims writes executable shims for the active clients', () => {
  const created = installShims();
  assert.deepEqual(created, [{ bin: 'redis-cli', target: path.join(root, 'bin', 'redis-cli') }]);

  const dest = path.join(dirs.shims, posix ? 'redis-cli' : 'redis-cli.cmd');
  assert.equal(fs.existsSync(dest), true);
  assert.match(fs.readFileSync(dest, 'utf8'), /shim-exec/);
  if (posix) assert.notEqual(fs.statSync(dest).mode & 0o111, 0, 'shim should be executable');

  // installing twice is idempotent and produces the same manifest
  assert.deepEqual(installShims(), created);
  assert.equal(fs.existsSync(dest), true);
});

test('shimScript embeds the node binary, CLI path and the forwarded argv', () => {
  const script = shimScript('redis-cli');
  assert.ok(script.includes(process.execPath), 'should invoke the running node binary');
  assert.ok(script.includes('bin/marina.js'), 'should point at the marina CLI');
  assert.ok(script.includes('shim-exec'));
  assert.ok(script.includes('redis-cli'));
  if (posix) assert.match(script, /^#!\/bin\/sh/);
});

test('shellenv exports MARINA_HOME and prepends the shims directory', () => {
  const text = shellenv();
  assert.ok(text.includes(HOME), 'MARINA_HOME should be the isolated runtime root');
  assert.ok(text.includes(dirs.shims));
  if (posix) {
    assert.match(text, /^export MARINA_HOME=/m);
    assert.match(text, /^export PATH=".*shims:\$PATH"$/m);
  } else {
    assert.match(text, /\$env:MARINA_HOME/);
    assert.match(text, /\$env:PATH/);
  }
});
