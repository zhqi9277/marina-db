// Exercise the installed CLI shape with isolated local payloads and no upstream requests.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));
const windows = process.platform === 'win32';

function fixture(t, { stopRedis = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marina-cli-'));
  const home = path.join(dir, 'runtime');
  const hooks = path.join(dir, 'hooks');
  const env = {
    ...process.env,
    MARINA_HOME: home,
    MARINA_NO_SERVICE: '1',
    MARINA_LAUNCHD_DIR: hooks,
    MARINA_SYSTEMD_DIR: hooks,
    MARINA_SCHTASKS_DIR: hooks,
    NO_COLOR: '1',
  };
  const node = (...args) => spawnSync(process.execPath, args, { cwd: repo, env, encoding: 'utf8', timeout: 12000 });
  const cli = (...args) => node('bin/marina.js', ...args);
  t.after(() => {
    if (stopRedis) cli('stop', 'redis@7');
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, home, hooks, env, node, cli };
}

function json(result, exit = 0) {
  assert.equal(result.status, exit, `${result.error || result.stderr}\n${result.stdout}`);
  return JSON.parse(result.stdout);
}

function localTarball(dir, name, binary, contents) {
  const payload = path.join(dir, 'payload');
  const bin = path.join(payload, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, binary), contents, { mode: 0o755 });
  const archive = path.join(dir, name);
  const tar = spawnSync('tar', ['-czf', archive, '-C', payload, '.'], { encoding: 'utf8' });
  assert.equal(tar.status, 0, tar.stderr);
  return archive;
}

test('autostart uses its saved runtime and emits a failing exit code with valid JSON', (t) => {
  const { cli, home, env, hooks } = fixture(t);
  fs.mkdirSync(path.join(home, 'engines', 'redis', '7', '7.4.1'), { recursive: true });
  const enabled = json(cli('autostart', 'redis', '--json'));
  assert.deepEqual(enabled.ids, ['redis:7']);
  const unit = fs.readFileSync(enabled.file, windows ? 'utf16le' : 'utf8');
  assert.ok(unit.includes('--runtime-home='));
  assert.equal(path.dirname(enabled.file), hooks);

  env.MARINA_HOME = path.join(home, 'another-home');
  const result = json(cli(`--runtime-home=${home}`, 'start', '--autostart', '--json'), 1);
  assert.match(result.failures[0].error, /payload for redis@7\.4\.1 is missing/);
  env.MARINA_HOME = home;
  assert.deepEqual(json(cli('autostart', 'redis', '--off', '--json')).ids, []);
  assert.equal(fs.existsSync(enabled.file), false);
});

test('failed initialization leaves no installed version or committed port', { skip: windows }, (t) => {
  const { cli, dir, home } = fixture(t);
  const file = localTarball(dir, 'mysql-8.4.1.tar.gz', 'mysqld', '#!/bin/sh\necho fixture-init-failed >&2\nexit 10\n');
  const result = cli('install', 'mysql@8.4.1', '--file', file, '--port', '25380');
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /fixture-init-failed/);
  assert.deepEqual(json(cli('ls', '--json')), []);
  assert.equal(fs.existsSync(path.join(home, 'etc', 'mysql', '8.4', 'my.cnf')), false);
  assert.equal(fs.existsSync(path.join(home, 'state.json')), false);
});

test('use keeps a path-free MySQL config and user setting', (t) => {
  const { cli, home } = fixture(t);
  const major = path.join(home, 'engines', 'mysql', '8.4');
  for (const version of ['8.4.1', '8.4.2']) {
    const bin = path.join(major, version, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, windows ? 'mysqld.exe' : 'mysqld'), '', { mode: 0o755 });
  }
  const confFile = path.join(home, 'etc', 'mysql', '8.4', 'my.cnf');
  fs.mkdirSync(path.dirname(confFile), { recursive: true });
  fs.writeFileSync(confFile, '[mysqld]\nmax_connections = 200\n');
  json(cli('use', 'mysql@8.4.1', '--json'));
  fs.appendFileSync(confFile, '\n# user setting\n');
  json(cli('use', 'mysql@8.4.2', '--json'));
  const config = fs.readFileSync(confFile, 'utf8');
  assert.doesNotMatch(config, /^\s*(basedir|datadir|pid-file|log-error|tmpdir)\s*=/m);
  assert.match(config, /# user setting/);
});

test('a manifest-only version resolves without consulting a remote index', (t) => {
  const { dir, env, node } = fixture(t);
  env.MARINA_CATALOG_FILE = path.join(dir, 'manifest.json');
  fs.writeFileSync(env.MARINA_CATALOG_FILE, JSON.stringify({ artifacts: [{
    name: 'redis', version: '99.0.1', os: process.platform, arch: process.arch, sha256: '0123456789abcdef'.repeat(4), url: 'https://example.test/redis.tar.gz',
  }] }));
  const target = json(node('--input-type=module', '-e', `
    import { resolveTarget } from './src/install/installer.js';
    const { version, channel } = await resolveTarget('redis@99.0.1');
    console.log(JSON.stringify({ version, channel }));
  `));
  assert.deepEqual(target, { version: '99.0.1', channel: 'catalog' });
});

test('CLI distinguishes selected and running versions on one instance', { skip: windows }, async (t) => {
  const { cli, dir } = fixture(t, { stopRedis: true });
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  const script = `#!/usr/bin/env node
const fs = require('node:fs');
const net = require('node:net');
const argv = process.argv.slice(2);
const text = fs.readFileSync(argv[0], 'utf8');
const valueAfter = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const port = Number(valueAfter('--port', (text.match(/^port (\\d+)$/m) || [])[1]));
const pidFile = valueAfter('--pidfile', (text.match(/^pidfile (.+)$/m) || [])[1]);
net.createServer((sock) => sock.end()).listen(port, '127.0.0.1', () => fs.writeFileSync(pidFile, String(process.pid)));
`;
  const old = localTarball(dir, 'redis-7.4.1.tar.gz', 'redis-server', script);
  const next = localTarball(dir, 'redis-7.4.2.tar.gz', 'redis-server', script);
  json(cli('install', 'redis@7.4.1', '--file', old, '--port', String(port), '--json'));
  const [{ pid }] = json(cli('start', 'redis', '--json'));
  json(cli('install', 'redis@7.4.2', '--file', next, '--json'));
  const [running, selected] = json(cli('ls', '--json'));
  assert.deepEqual([running.version, running.active, running.state, running.pid], ['7.4.1', false, 'running', pid]);
  assert.deepEqual([selected.version, selected.active, selected.state, selected.runningVersion], ['7.4.2', true, 'inactive', '7.4.1']);
  json(cli('stop', 'redis@7.4.2', '--json'));
  assert.equal(json(cli('status', 'redis@7.4.1', '--json')).pid, pid);
  json(cli('use', 'redis@7.4.2', '--restart', '--json'));
  const upgraded = json(cli('status', 'redis', '--json'));
  assert.equal(upgraded.state, 'running');
  assert.equal(upgraded.runningVersion, '7.4.2');
  assert.notEqual(upgraded.pid, pid);
  json(cli('stop', 'redis', '--json'));
});
