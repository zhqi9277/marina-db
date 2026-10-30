// Regression tests for the core fixes: pid ownership/stop confirmation, state
// file normalization + permissions, install port validation/cache refresh,
// download size verification and autostart unit cleanup.
// Everything runs in throwaway temp dirs: no database is started, no network.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'marina-regression-'));
process.env.MARINA_HOME = HOME;
process.env.NO_COLOR = '1';

const tempDirs = [HOME];
function tmp(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `marina-${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

// paths.js/state.js capture MARINA_HOME at import time, so import after setting it
const lifecycle = await import('../src/lifecycle.js');
const state = await import('../src/state.js');
const installer = await import('../src/installer.js');
const download = await import('../src/download.js');
const autostart = await import('../src/autostart.js');
const redisEngine = (await import('../src/engines/redis.js')).default;
const mariaEngine = (await import('../src/engines/mariadb.js')).default;
const mysqlEngine = (await import('../src/engines/mysql.js')).default;
const shims = await import('../src/shims.js');
const configcheck = await import('../src/configcheck.js');
const settings = await import('../src/settings.js');
const project = await import('../src/project.js');
const registry = await import('../src/registry.js');
const ui = await import('../src/ui.js');

ui.setQuiet(true);

after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- helpers ---

async function freePort() {
  const srv = net.createServer();
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const { port } = srv.address();
  await new Promise((resolve) => srv.close(resolve));
  return port;
}

/** A port kept open for the duration of a test (stands in for a live server). */
async function listeningPort() {
  const srv = net.createServer();
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  return {
    srv,
    port: srv.address().port,
    close: () => new Promise((resolve) => srv.close(resolve)),
  };
}

function writeExecutable(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, { mode: 0o755 });
  fs.chmodSync(file, 0o755);
  return file;
}

function writeConf(name, text) {
  const file = path.join(tmp('conf'), name);
  fs.writeFileSync(file, text);
  return file;
}

function spawnHold(cwd) {
  // cwd and the trailing argv are what marina uses as the ownership markers for
  // its servers (command line on macOS, /proc cwd on Linux)
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)', cwd], {
    cwd,
    stdio: 'ignore',
  });
  child.unref();
  return child;
}

async function waitDead(pid, timeout = 5000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (!lifecycle.pidAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return !lifecycle.pidAlive(pid);
}

/**
 * Capture CLI stderr for tests that must assert a warning is visible. Only
 * stderr is patched: the test reporter writes through process.stdout, so
 * replacing that would swallow its own result lines (stdout noise is fine).
 */
function captureStderr() {
  const original = process.stderr.write;
  let captured = '';
  process.stderr.write = (chunk) => {
    captured += String(chunk);
    return true;
  };
  return {
    get captured() {
      return captured;
    },
    restore() {
      process.stderr.write = original;
    },
  };
}

function makeCtx(root, { pidFile, port = 1, probe = async () => false, startCommand, stopCommand } = {}) {
  const pid = pidFile || path.join(root, 'server.pid');
  const engine = {
    key: 'redis',
    label: 'Redis',
    serverBin: ['redis-server'],
    markers: [],
    probe,
    readPid() {
      try {
        return parseInt(fs.readFileSync(pid, 'utf8').trim(), 10) || null;
      } catch {
        return null;
      }
    },
    cleanRuntime() {},
    stopCommand() {
      return null;
    },
  };
  if (startCommand) engine.startCommand = startCommand;
  if (stopCommand) engine.stopCommand = stopCommand;
  return {
    engine,
    key: 'redis',
    label: 'Redis',
    major: '7',
    version: '7.0.0',
    port,
    root,
    pidFile: pid,
    sockFile: path.join(root, 'server.sock'),
    dataDir: path.join(root, 'data'),
    logDir: root,
    logFile: path.join(root, 'server.log'),
    confFile: null,
  };
}

/** fake "server" that records its pid (in pidFile and witness) and then idles */
function fakeServerScript(root, pidFile) {
  const witness = `${pidFile}.witness`;
  const script = path.join(root, 'fake-server.mjs');
  fs.writeFileSync(
    script,
    [
      "import fs from 'node:fs';",
      `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
      `fs.writeFileSync(${JSON.stringify(witness)}, String(process.pid));`,
      'setTimeout(() => {}, 60000);',
      '',
    ].join('\n'),
  );
  return { script, witness };
}

function readWitness(file) {
  return Number(fs.readFileSync(file, 'utf8'));
}

// These spawn a live process and read it back. Windows command-line matching is fixture-tested in test/host.mjs.
const notWindows = process.platform === 'win32' ? 'live pid inspection test runs on the POSIX host' : false

// ------------------------------------------------------------ lifecycle ----

test('pidOwnedBy only trusts a pid whose command line lives under this install', { skip: notWindows }, () => {
  const root = tmp('owner');
  const foreign = tmp('foreign');
  const owned = spawnHold(root);
  const other = spawnHold(foreign);
  try {
    assert.equal(lifecycle.pidOwnedBy(owned.pid, makeCtx(root)), true);
    assert.equal(lifecycle.pidOwnedBy(other.pid, makeCtx(root)), false);
    assert.equal(lifecycle.pidOwnedBy(999999999, makeCtx(root)), false);
  } finally {
    for (const child of [owned, other]) {
      try { process.kill(child.pid, 'SIGKILL'); } catch {}
    }
  }
});

test('pidOwnedBy accepts a moved install by its layout but never a system binary', { skip: notWindows }, () => {
  const oldRoot = tmp('moved-old');
  const newRoot = tmp('moved-new');
  const child = spawnHold(tmp('moved-proc'));
  const ctx = makeCtx(newRoot, { pidFile: path.join(newRoot, 'server.pid') });
  const server = (root) => path.join(root, 'engines', 'redis', '7', '7.0.0', 'bin', 'redis-server');
  const conf = (root) => path.join(root, 'etc', 'redis', '7', 'redis.conf');
  const currentCommand = `${server(ctx.root)} ${conf(ctx.root)}`;
  const oldCommand = `${server(oldRoot)} ${conf(oldRoot)}`;
  try {
    assert.equal(oldCommand.includes(ctx.root), false, 'the old command must not mention the new root');
    assert.equal(lifecycle.pidOwnedBy(child.pid, ctx, { command: currentCommand, cwd: null }), true);
    assert.equal(
      lifecycle.pidOwnedBy(child.pid, ctx, { command: oldCommand, cwd: null }),
      true,
      'an install moved to another directory must still be recognised via engines/<key>/',
    );
    assert.equal(
      lifecycle.pidOwnedBy(child.pid, ctx, { command: '/usr/local/bin/mysqld --datadir=/var/lib/mysql', cwd: null }),
      false,
    );
    assert.equal(lifecycle.pidOwnedBy(child.pid, ctx, { command: 'sleep 300', cwd: '/tmp' }), false);
  } finally {
    try { process.kill(child.pid, 'SIGKILL'); } catch {}
  }
});

test('stop() terminates a pre-move server whose cwd is the old dataDir', { skip: notWindows }, async () => {
  const oldRoot = tmp('moved-old-cwd');
  const oldData = path.join(oldRoot, 'data', 'redis', '7');
  fs.mkdirSync(oldData, { recursive: true });
  const root = tmp('moved-new-cwd');
  const pidFile = path.join(root, 'server.pid');
  const child = spawnHold(oldData); // redis chdir's into its datadir
  fs.writeFileSync(pidFile, String(child.pid));
  const ctx = makeCtx(root, { pidFile });
  try {
    assert.equal(lifecycle.pidOwnedBy(child.pid, ctx), true, 'data/<key>/<major> cwd identifies the old install');
    const res = await lifecycle.stop(ctx, { quiet: true });
    assert.equal(res.stopped, true);
    assert.equal(await waitDead(child.pid), true, 'the pre-move process must actually be terminated');
    assert.equal(fs.existsSync(pidFile), false);
  } finally {
    try { process.kill(child.pid, 'SIGKILL'); } catch {}
  }
});

test('stop() really terminates a live pid even when the health probe says "down"', async () => {
  const root = tmp('stop');
  const pidFile = path.join(root, 'server.pid');
  const child = spawnHold(root);
  fs.writeFileSync(pidFile, String(child.pid));
  const ctx = makeCtx(root, { pidFile });
  try {
    const res = await lifecycle.stop(ctx, { quiet: true });
    assert.equal(res.stopped, true);
    assert.equal(await waitDead(child.pid), true, 'stop must not leave the server running');
    assert.equal(fs.existsSync(pidFile), false, 'runtime pid file must be cleaned');
  } finally {
    try { process.kill(child.pid, 'SIGKILL'); } catch {}
  }
});

test('stop() does not signal a pid that was reused by an unrelated process', { skip: notWindows }, async () => {
  const root = tmp('stop-owned');
  const foreign = tmp('stop-foreign');
  const pidFile = path.join(root, 'server.pid');
  const child = spawnHold(foreign);
  fs.writeFileSync(pidFile, String(child.pid));
  const ctx = makeCtx(root, { pidFile });
  try {
    assert.equal(lifecycle.pidOwnedBy(child.pid, ctx), false);
    const res = await lifecycle.stop(ctx, { quiet: true });
    // nothing of ours was running: stop() must not report it stopped anything
    assert.equal(res.stopped, false);
    assert.equal(res.already, true);
    assert.equal(lifecycle.pidAlive(child.pid), true, 'an unrelated process must survive stop()');
    assert.equal(fs.existsSync(pidFile), false, 'the stale pid file is still removed');
  } finally {
    try { process.kill(child.pid, 'SIGKILL'); } catch {}
  }
});

test('stop() is idempotent when nothing is running', async () => {
  const root = tmp('stop-idle');
  const ctx = makeCtx(root, { pidFile: path.join(root, 'server.pid') });
  const res = await lifecycle.stop(ctx, { quiet: true });
  assert.equal(res.already, true);
});

test('status() reports a foreign listener as port-busy, never as running', async () => {
  const root = tmp('foreign-status');
  const live = await listeningPort();
  const ctx = makeCtx(root, { pidFile: path.join(root, 'server.pid'), port: live.port });
  try {
    const st = await lifecycle.status(ctx);
    assert.equal(st.state, 'port-busy', 'an open port marina did not open is not a running service');
    assert.equal(st.healthy, false);
    assert.equal(st.pid, null);
  } finally {
    await live.close();
  }
});

test('stop() does not claim it stopped a port that belongs to another process', async () => {
  const root = tmp('foreign-stop');
  const live = await listeningPort();
  const ctx = makeCtx(root, { pidFile: path.join(root, 'server.pid'), port: live.port });
  const out = captureStderr();
  ui.setQuiet(false);
  try {
    const t0 = Date.now();
    const res = await lifecycle.stop(ctx, { quiet: false });
    assert.equal(res.stopped, false);
    assert.equal(res.portBusy, true);
    assert.equal(res.already, true);
    assert.ok(Date.now() - t0 < 2000, 'a foreign listener must not cost a graceful-stop timeout');
    assert.equal(await lifecycle.tcpProbe(live.port), true, 'another process must never be shut down');
    assert.match(out.captured, /port \d+ is held by another process marina did not start/);
  } finally {
    ui.setQuiet(true);
    out.restore();
    await live.close();
  }
});

test('start() refuses to start on a port held by a foreign process', async () => {
  const root = tmp('foreign-start');
  const live = await listeningPort();
  let started = false;
  const ctx = makeCtx(root, {
    pidFile: path.join(root, 'server.pid'),
    port: live.port,
    startCommand: () => {
      started = true;
      return { cmd: process.execPath, args: ['-e', ''], foreground: true };
    },
  });
  const t0 = Date.now();
  try {
    await assert.rejects(
      lifecycle.start(ctx, { quiet: true, timeoutMs: 500 }),
      /already in use by a process marina did not start/,
    );
    assert.equal(started, false, 'no server may be spawned while the port is taken');
    assert.ok(Date.now() - t0 < 2000, 'the conflict must be reported before any readiness wait');
  } finally {
    await live.close();
  }
});

test('status() reports our own unresponsive pid as degraded', async () => {
  const root = tmp('degraded');
  const pidFile = path.join(root, 'server.pid');
  const child = spawnHold(root);
  fs.writeFileSync(pidFile, String(child.pid));
  const ctx = makeCtx(root, { pidFile });
  try {
    const st = await lifecycle.status(ctx);
    assert.equal(st.state, 'degraded');
    assert.equal(st.pid, child.pid);
    assert.equal(st.healthy, false);
  } finally {
    try { process.kill(child.pid, 'SIGKILL'); } catch {}
  }
});

test('stop() surfaces a failed stopCommand and still falls back to the pid', async () => {
  const root = tmp('stop-cmd');
  const pidFile = path.join(root, 'server.pid');
  const child = spawnHold(root);
  fs.writeFileSync(pidFile, String(child.pid));
  let probed = false;
  const ctx = makeCtx(root, {
    pidFile,
    port: await freePort(),
    probe: async () => {
      const first = !probed;
      probed = true;
      return first; // stop() sees "running", then the fallback probe sees "down"
    },
    stopCommand: () => ({
      cmd: process.execPath,
      args: ['-e', 'console.error("shutdown denied"); process.exit(1)'],
    }),
  });

  const out = captureStderr();
  ui.setQuiet(false);
  try {
    const res = await lifecycle.stop(ctx, { quiet: false });
    assert.equal(res.stopped, true);
    assert.equal(await waitDead(child.pid), true, 'the pid fallback must still terminate the server');
    assert.match(
      out.captured,
      /graceful stop command failed: .*exited 1: shutdown denied/,
      'the failed shutdown helper must be visible',
    );
  } finally {
    ui.setQuiet(true);
    out.restore();
    try { process.kill(child.pid, 'SIGKILL'); } catch {}
  }
});

test('stop() warns but still stops when the stopCommand cannot be spawned', async () => {
  const root = tmp('stop-cmd-missing');
  const pidFile = path.join(root, 'server.pid');
  const child = spawnHold(root);
  fs.writeFileSync(pidFile, String(child.pid));
  const ctx = makeCtx(root, {
    pidFile,
    stopCommand: () => ({ cmd: path.join(root, 'no-such-admin'), args: [] }),
  });

  const out = captureStderr();
  ui.setQuiet(false);
  try {
    const res = await lifecycle.stop(ctx, { quiet: false });
    assert.equal(res.stopped, true);
    assert.equal(await waitDead(child.pid), true);
    assert.match(out.captured, /graceful stop command failed: .*could not run:/);
  } finally {
    ui.setQuiet(true);
    out.restore();
    try { process.kill(child.pid, 'SIGKILL'); } catch {}
  }
});

test('start() fails fast instead of crashing when the server binary cannot spawn', async () => {
  const root = tmp('spawn');
  const ctx = makeCtx(root, {
    pidFile: path.join(root, 'server.pid'),
    startCommand: () => ({ cmd: path.join(root, 'does-not-exist'), args: [], foreground: true }),
  });
  const t0 = Date.now();
  await assert.rejects(lifecycle.start(ctx, { quiet: true, timeoutMs: 200 }), /failed to start Redis/);
  assert.ok(Date.now() - t0 < 3000, 'a missing binary must not wait for the readiness timeout');
});

test('start() kills the process it spawned when readiness times out', async () => {
  const root = tmp('timeout');
  const pidFile = path.join(root, 'server.pid');
  const { script, witness } = fakeServerScript(root, pidFile);
  const ctx = makeCtx(root, {
    pidFile,
    port: await freePort(),
    startCommand: () => ({ cmd: process.execPath, args: [script], foreground: true }),
  });
  await assert.rejects(lifecycle.start(ctx, { quiet: true, timeoutMs: 500 }), /did not become ready/);
  const pid = readWitness(witness);
  assert.equal(await waitDead(pid), true, 'a failed start must not leak its child process');
  assert.equal(fs.existsSync(pidFile), false);
});

test('start() reclaims a stale pid only when it belongs to this install', async () => {
  const root = tmp('stale');
  const foreign = tmp('stale-foreign');
  const pidFile = path.join(root, 'server.pid');
  const stale = spawnHold(root);
  const bystander = spawnHold(foreign);
  fs.writeFileSync(pidFile, String(stale.pid));
  const { script, witness } = fakeServerScript(root, pidFile);
  const ctx = makeCtx(root, {
    pidFile,
    port: await freePort(),
    startCommand: () => ({ cmd: process.execPath, args: [script], foreground: true }),
  });
  try {
    await assert.rejects(lifecycle.start(ctx, { quiet: true, timeoutMs: 400 }), /did not become ready/);
    assert.equal(await waitDead(stale.pid), true, 'the old marina process must be reclaimed');
    assert.equal(await waitDead(readWitness(witness)), true, 'the failed replacement must not leak');
    assert.equal(lifecycle.pidAlive(bystander.pid), true);

    // the same stale pid file, but now pointing at a process marina never started
    fs.writeFileSync(pidFile, String(bystander.pid));
    await assert.rejects(lifecycle.start(ctx, { quiet: true, timeoutMs: 400 }), /did not become ready/);
    assert.equal(lifecycle.pidAlive(bystander.pid), true, 'pid reuse must never be killed');
    assert.equal(await waitDead(readWitness(witness)), true);
  } finally {
    for (const child of [stale, bystander]) {
      try { process.kill(child.pid, 'SIGKILL'); } catch {}
    }
  }
});

// ------------------------------------------------- mysql family helpers ----

test('mariadb shuts down through mariadb-admin, not the deprecated mysqladmin alias', () => {
  const root = tmp('admin-pick');
  for (const name of ['mysqladmin', 'mariadb-admin']) {
    writeExecutable(path.join(root, 'bin', name), '#!/bin/sh\nexit 0\n');
  }
  const ctx = {
    root,
    major: '11.4',
    port: 3307,
    sockFile: path.join(root, 'x.sock'),
    account: { user: 'root', password: 'pw' },
  };
  assert.equal(path.basename(mariaEngine.stopCommand(ctx).cmd), 'mariadb-admin');
  assert.equal(path.basename(mysqlEngine.stopCommand(ctx).cmd), 'mysqladmin');
});

test('firstDiagnostic skips the MariaDB deprecation notice', () => {
  const stderr = [
    '/x/bin/mysqladmin: Deprecated program name. It will be removed in a future release, use \'mariadb-admin\' instead',
    "/x/bin/mysqladmin: connect to server at 'localhost' failed",
    "error: 'Can't connect to local server through socket /x/run/mariadb-11.4.sock'",
  ].join('\n');
  assert.equal(lifecycle.firstDiagnostic(stderr), "/x/bin/mysqladmin: connect to server at 'localhost' failed");
  assert.equal(lifecycle.firstDiagnostic(''), '');
});

test('a failed shutdown helper reports the real error, not the deprecation noise', async () => {
  const root = tmp('stop-noise');
  const pidFile = path.join(root, 'server.pid');
  const child = spawnHold(root);
  fs.writeFileSync(pidFile, String(child.pid));
  const ctx = makeCtx(root, {
    pidFile,
    stopCommand: () => ({
      cmd: process.execPath,
      args: [
        '-e',
        'console.error("mysqladmin: Deprecated program name. It will be removed in a future release"); console.error("connect to server failed"); process.exit(1)',
      ],
    }),
  });
  const out = captureStderr();
  ui.setQuiet(false);
  try {
    const res = await lifecycle.stop(ctx, { quiet: false });
    assert.equal(res.stopped, true);
    assert.equal(await waitDead(child.pid), true, 'the pid fallback still stops the server');
    assert.match(out.captured, /exited 1: connect to server failed/);
    assert.doesNotMatch(out.captured, /exited 1: mysqladmin: Deprecated/);
  } finally {
    ui.setQuiet(true);
    out.restore();
    try { process.kill(child.pid, 'SIGKILL'); } catch {}
  }
});

// ---------------------------------------------------------------- state ----

function writeState(value) {
  fs.writeFileSync(path.join(HOME, 'state.json'), typeof value === 'string' ? value : JSON.stringify(value));
}

test('state.load() normalizes null/wrong-typed sections instead of throwing', () => {
  writeState({
    active: null,
    ports: null,
    settings: { accounts: null, autostart: 'not-an-array' },
  });
  const loaded = state.load();
  assert.deepEqual(loaded.active, {});
  assert.deepEqual(loaded.ports, {});
  assert.deepEqual(loaded.settings.accounts, {});
  assert.deepEqual(loaded.settings.autostart, []);
  assert.equal(state.getActive('mysql'), null);
  assert.equal(state.portOf('mysql', '8.4', 3306), 3306);
  assert.deepEqual(state.autostartList(), []);
});

test('state.load() drops invalid active/port values', () => {
  writeState({
    active: { mysql: '8.4.11', redis: null, memcached: 12 },
    ports: { 'mysql:8.4': '3307', 'redis:7': 0, 'memcached:1': 11211, 'postgres:17': 70000 },
  });
  const loaded = state.load();
  assert.deepEqual(loaded.active, { mysql: '8.4.11' });
  assert.deepEqual(loaded.ports, { 'memcached:1': 11211 });
  assert.equal(state.portOf('mysql', '8.4', 3306), 3306);
  assert.equal(state.portOf('memcached', '1', 11211), 11211);
});

test('state.load() falls back to defaults for a corrupt state.json', () => {
  writeState('{ this is not json');
  const loaded = state.load();
  assert.equal(loaded.version, 1);
  assert.deepEqual(loaded.active, {});
  assert.equal(state.getActive('postgres'), null);
});

test('state.setPort() rejects invalid ports and persists valid ones', () => {
  for (const bad of [0, -1, 65536, 'abc', 1.5, null]) {
    assert.throws(() => state.setPort('mysql', '8.4', bad), /port must be 1\.\.65535/);
  }
  state.setPort('mysql', '8.4', 3307);
  assert.equal(state.portOf('mysql', '8.4', 3306), 3307);
});

test('state.save() writes state.json atomically with private permissions', () => {
  state.setActive('redis', '7.0.0');
  const file = path.join(HOME, 'state.json');
  const leftovers = fs.readdirSync(HOME).filter((name) => name.endsWith('.tmp'));
  assert.deepEqual(leftovers, [], 'no temporary file may be left behind');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).active, { redis: '7.0.0' });
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'credentials must not be world readable');
  }
});

test('state.mutate serializes concurrent read-modify-write across processes', async () => {
  state.mutate((s) => {
    s.counter = 0;
  });
  const stateUrl = new URL('../src/state.js', import.meta.url).href;
  const childScript = [
    `const state = await import(${JSON.stringify(stateUrl)});`,
    'for (let i = 0; i < 15; i++) state.mutate((s) => { s.counter = (s.counter || 0) + 1; });',
    '',
  ].join('\n');
  const runChild = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', childScript], {
      env: { ...process.env, MARINA_HOME: HOME, MARINA_STATE_LOCK_TIMEOUT: '5000' },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`child exited ${code}: ${stderr}`))));
  });

  await Promise.all([runChild(), runChild(), runChild()]);
  assert.equal(state.load().counter, 45, '3 processes × 15 increments must lose no update');
  assert.equal(fs.existsSync(path.join(HOME, 'state.lock')), false, 'the lock must be released');
});

test('state.mutate reclaims dead, ownerless, self-owned and stale locks', () => {
  const lock = path.join(HOME, 'state.lock');
  const savedTimeout = process.env.MARINA_STATE_LOCK_TIMEOUT;
  const savedStale = process.env.MARINA_STATE_LOCK_STALE;
  const age = (dir, ms) => {
    const old = new Date(Date.now() - ms);
    fs.utimesSync(dir, old, old);
  };
  try {
    process.env.MARINA_STATE_LOCK_TIMEOUT = '1000';
    process.env.MARINA_STATE_LOCK_STALE = '600000';

    // 1) owner pid no longer exists
    fs.mkdirSync(lock, { recursive: true });
    fs.writeFileSync(path.join(lock, 'pid'), '2147483646');
    state.mutate((s) => { s.settings.__staleOwner = true; });
    assert.equal(state.load().settings.__staleOwner, true);
    assert.equal(fs.existsSync(lock), false);

    // 2) pid file was never written (creator died between mkdir and write)
    fs.mkdirSync(lock, { recursive: true });
    age(lock, 1000);
    state.mutate((s) => { s.settings.__ownerless = true; });
    assert.equal(state.load().settings.__ownerless, true);
    assert.equal(fs.existsSync(lock), false);

    // 3) aged lock "owned" by this very pid = leftover from a previous run
    fs.mkdirSync(lock, { recursive: true });
    fs.writeFileSync(path.join(lock, 'pid'), String(process.pid));
    age(lock, 1000);
    state.mutate((s) => { s.settings.__selfLeftover = true; });
    assert.equal(state.load().settings.__selfLeftover, true);
    assert.equal(fs.existsSync(lock), false);

    // 4) lock older than MARINA_STATE_LOCK_STALE even with a live owner
    fs.mkdirSync(lock, { recursive: true });
    fs.writeFileSync(path.join(lock, 'pid'), String(process.ppid));
    age(lock, 60000);
    process.env.MARINA_STATE_LOCK_STALE = '1000';
    state.mutate((s) => { s.settings.__staleAge = true; });
    assert.equal(state.load().settings.__staleAge, true);
    assert.equal(fs.existsSync(lock), false);
  } finally {
    if (savedTimeout === undefined) delete process.env.MARINA_STATE_LOCK_TIMEOUT;
    else process.env.MARINA_STATE_LOCK_TIMEOUT = savedTimeout;
    if (savedStale === undefined) delete process.env.MARINA_STATE_LOCK_STALE;
    else process.env.MARINA_STATE_LOCK_STALE = savedStale;
    fs.rmSync(lock, { recursive: true, force: true });
  }
});

test('state.mutate times out with an actionable error when the lock stays held', () => {
  const lock = path.join(HOME, 'state.lock');
  const savedTimeout = process.env.MARINA_STATE_LOCK_TIMEOUT;
  const savedStale = process.env.MARINA_STATE_LOCK_STALE;
  fs.mkdirSync(lock, { recursive: true });
  fs.writeFileSync(path.join(lock, 'pid'), String(process.pid));
  process.env.MARINA_STATE_LOCK_TIMEOUT = '50';
  process.env.MARINA_STATE_LOCK_STALE = '60000';
  const t0 = Date.now();
  try {
    assert.throws(
      () => state.mutate((s) => { s.settings.__held = true; }),
      (e) => {
        assert.match(e.message, /state\.lock timeout after 50ms/);
        assert.ok(e.message.includes(lock), 'the error must name the lock path');
        assert.ok(e.message.includes(`pid ${process.pid}`), 'the error must name the holder');
        return true;
      },
    );
    assert.ok(Date.now() - t0 < 2000, 'timeout must be honoured, not the default');
    assert.equal(state.load().settings.__held, undefined, 'a timed-out write must not touch state.json');
  } finally {
    if (savedTimeout === undefined) delete process.env.MARINA_STATE_LOCK_TIMEOUT;
    else process.env.MARINA_STATE_LOCK_TIMEOUT = savedTimeout;
    if (savedStale === undefined) delete process.env.MARINA_STATE_LOCK_STALE;
    else process.env.MARINA_STATE_LOCK_STALE = savedStale;
    fs.rmSync(lock, { recursive: true, force: true });
  }
});

test('state.mutate releases the lock when the mutation throws', () => {
  assert.throws(() => state.mutate(() => { throw new Error('boom'); }), /boom/);
  assert.equal(fs.existsSync(path.join(HOME, 'state.lock')), false, 'a thrown mutation must release the lock');
  state.mutate((s) => { s.settings.__afterThrow = true; });
  assert.equal(state.load().settings.__afterThrow, true);
});

// ------------------------------------------------------------ installer ----

test('install() rejects an invalid --port before resolving/downloading', async () => {
  for (const bad of [0, 'abc', 65536, -5]) {
    const t0 = Date.now();
    await assert.rejects(installer.install('mysql@8.4', { port: bad }), /port must be 1\.\.65535/);
    assert.ok(Date.now() - t0 < 2000, 'validation must happen before any network access');
  }
});

test('fetchPackage() refreshes a cached local payload with the same file name', async () => {
  const dir = tmp('file');
  const name = 'redis-7.4.11.tar.gz';
  const source = path.join(dir, name);
  fs.writeFileSync(source, 'fresh payload');
  const cached = path.join(HOME, 'cache', 'redis', '7.4.11', name);
  fs.mkdirSync(path.dirname(cached), { recursive: true });
  fs.writeFileSync(cached, 'stale payload');

  const out = await installer.fetchPackage({ file: source, engine: { key: 'redis' }, version: '7.4.11' });
  assert.equal(out.tarball, cached);
  assert.equal(fs.readFileSync(cached, 'utf8'), 'fresh payload');
  assert.equal(out.sha256, crypto.createHash('sha256').update('fresh payload').digest('hex'));

  // --file pointing at the cache entry itself must not copy a file onto itself
  const same = await installer.fetchPackage({ file: cached, engine: { key: 'redis' }, version: '7.4.11' });
  assert.equal(same.tarball, cached);
  assert.equal(fs.readFileSync(cached, 'utf8'), 'fresh payload');
});

// ------------------------------------------------- payload materialize ----

const FAKE_ENGINE = () => ({ key: 'faketool', label: 'FakeTool', markers: ['bin/faketool'], clientBins: [] });

/** create engines/faketool/<major>/<version> path used by materializePayload */
function fakeVersionDir(major, version) {
  return path.join(HOME, 'engines', 'faketool', major, version);
}

function tarballWith(prefix, files) {
  const source = tmp(`${prefix}-src`);
  for (const [rel, body] of Object.entries(files)) {
    const file = path.join(source, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body, { mode: 0o755 });
    fs.chmodSync(file, 0o755);
  }
  const tarball = path.join(tmp(`${prefix}-tar`), `${prefix}.tar.gz`);
  const res = spawnSync('tar', ['-czf', tarball, '-C', source, '.']);
  assert.equal(res.status, 0, `tar fixture failed: ${String(res.stderr || '')}`);
  return tarball;
}

test('materializePayload extracts a fresh payload and reuses a complete one', async () => {
  const tarball = tarballWith('payload-ok', { 'bin/faketool': '#!/bin/sh\nexit 0\n' });
  const target = { tarball, kind: 'binary', major: '1', version: '1.0.0' };
  const ctx = await installer.materializePayload(target, FAKE_ENGINE());
  assert.equal(ctx.reused, false);
  const marker = path.join(fakeVersionDir('1', '1.0.0'), 'bin', 'faketool');
  assert.equal(fs.existsSync(marker), true);

  // a complete payload is reused even when the (unused) tarball disappeared
  const again = await installer.materializePayload(
    { ...target, tarball: path.join(tmp('missing'), 'gone.tar.gz') },
    FAKE_ENGINE(),
  );
  assert.equal(again.reused, true);
  assert.equal(fs.existsSync(marker), true, 'a reused payload must not be deleted');
});

test('materializePayload heals an incomplete dest by re-extracting', async () => {
  const tarball = tarballWith('payload-heal', { 'bin/faketool': '#!/bin/sh\nexit 0\n' });
  const dest = fakeVersionDir('2', '2.0.0');
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(path.join(dest, 'junk.txt'), 'half installed');

  const out = await installer.materializePayload({ tarball, kind: 'binary', major: '2', version: '2.0.0' }, FAKE_ENGINE());
  assert.equal(out.reused, false);
  assert.equal(fs.existsSync(path.join(dest, 'bin', 'faketool')), true);
  assert.equal(fs.existsSync(path.join(dest, 'junk.txt')), false, 'the incomplete dest is replaced, not merged');
});

test('materializePayload removes a new dest when extraction fails', async () => {
  const bad = path.join(tmp('payload-bad'), 'bad.tar.gz');
  fs.writeFileSync(bad, 'this is not a tarball');
  const target = { tarball: bad, kind: 'binary', major: '3', version: '3.0.0' };
  await assert.rejects(installer.materializePayload(target, FAKE_ENGINE()), /tar failed/);
  assert.equal(fs.existsSync(fakeVersionDir('3', '3.0.0')), false, 'a failed extraction must leave no dest');
  const stages = fs.existsSync(path.join(HOME, 'engines', 'faketool', '3'))
    ? fs.readdirSync(path.join(HOME, 'engines', 'faketool', '3')).filter((n) => n.startsWith('.stage-'))
    : [];
  assert.deepEqual(stages, [], 'the staging directory must be removed');
});

test('materializePayload rejects a binary payload without the engine marker', async () => {
  const tarball = tarballWith('payload-nomarker', { 'share/readme.txt': 'no binaries here' });
  const target = { tarball, kind: 'binary', major: '5', version: '5.0.0' };
  await assert.rejects(installer.materializePayload(target, FAKE_ENGINE()), /unrecognized payload layout/);
  assert.equal(fs.existsSync(fakeVersionDir('5', '5.0.0')), false, 'a marker-less payload must leave no dest');
});

test('materializePayload removes the dest when a source build fails', async (t) => {
  if (process.platform === 'win32') return t.skip('POSIX tar fixture');
  const tarball = tarballWith('payload-build', { 'src/hello.txt': 'hi' });
  const target = {
    tarball,
    kind: 'source',
    major: '4',
    version: '4.0.0',
    build: { steps: [[process.execPath, '-e', 'process.exit(1)']], bins: {} },
  };
  await assert.rejects(installer.materializePayload(target, FAKE_ENGINE()), /build step failed/);
  assert.equal(fs.existsSync(fakeVersionDir('4', '4.0.0')), false, 'a failed source build must leave no payload');
});

test('redis config writes requirepass for the stored password', () => {
  const ctx = {
    port: 6379,
    pidFile: '/tmp/redis.pid',
    logFile: '/tmp/redis.log',
    dataDir: '/tmp/redis-data',
    account: { password: null },
  };
  assert.doesNotMatch(redisEngine.renderConfig(ctx), /requirepass/);
  assert.doesNotMatch(redisEngine.renderConfig({ ...ctx, account: { password: '' } }), /requirepass/);
  assert.match(redisEngine.renderConfig({ ...ctx, account: { password: 's3cret' } }), /^requirepass s3cret$/m);
  assert.ok(
    redisEngine.renderConfig({ ...ctx, account: { password: 'p@ss "wo rd\\' } })
      .includes('requirepass "p@ss \\"wo rd\\\\"\n'),
    'spaces/quotes/backslashes must be quoted so the password cannot inject directives',
  );
  assert.ok(
    redisEngine.renderConfig({ ...ctx, account: { password: 'line\nbreak' } }).includes('requirepass "line\\x0abreak"'),
    'newlines must not split the config into a new directive',
  );
});

// ------------------------------------------------------------- download ----

function serve(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}/payload.bin`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

test('downloadFile() rejects a truncated transfer instead of caching it', async () => {
  // HEAD-ish range probe advertises 100 bytes, the body only delivers 10
  const fixture = await serve((req, res) => {
    if (req.headers.range) {
      res.writeHead(206, { 'content-range': 'bytes 0-0/100', 'content-length': '1' });
      res.end('x');
      return;
    }
    res.writeHead(200, { 'content-length': '10' });
    res.end('0123456789');
  });
  const dest = path.join(tmp('download-bad'), 'payload.bin');
  try {
    await assert.rejects(
      download.downloadFile(fixture.url, dest, { label: 'payload.bin', retries: 0 }),
      /incomplete download for payload\.bin: received 10 of 100 bytes/,
    );
    assert.equal(fs.existsSync(dest), false, 'a truncated payload must not enter the cache');
    assert.equal(fs.existsSync(`${dest}.part`), false, 'the broken partial file is discarded');
  } finally {
    await fixture.close();
  }
});

test('downloadFile() verifies and stores a complete payload', async () => {
  const body = 'hello marina';
  const fixture = await serve((req, res) => {
    res.writeHead(200, { 'content-length': String(Buffer.byteLength(body)) });
    res.end(body);
  });
  const dest = path.join(tmp('download-good'), 'payload.bin');
  const sha256 = crypto.createHash('sha256').update(body).digest('hex');
  try {
    await download.downloadFile(fixture.url, dest, { sha256, retries: 0 });
    assert.equal(fs.readFileSync(dest, 'utf8'), body);
    assert.equal(fs.existsSync(`${dest}.part`), false);
  } finally {
    await fixture.close();
  }
});

// ---------------------------------------------------------------- shims ----

test('resolveBin falls through to mariadb when mysql is not installed', {
  skip: process.platform === 'win32' ? 'executable-bit discovery is POSIX-only' : false,
}, () => {
  const root = path.join(HOME, 'engines', 'mariadb', '11.4', '11.4.13');
  const mysql = writeExecutable(path.join(root, 'bin', 'mysql'), '#!/bin/sh\nexit 0\n');
  // the mariadb package carries the mysql client name
  state.setActive('mariadb', '11.4.13');

  const hit = shims.resolveBin('mysql');
  assert.ok(hit, 'mysql must resolve through mariadb when only mariadb is installed');
  assert.equal(hit.engine.key, 'mariadb');
  assert.equal(hit.path, mysql);
});

// ---------------------------------------------------------- configcheck ----

test('staleConfigReferences understands redis.conf / mongod.yaml directives outside runtime/', () => {
  const redisConf = writeConf('redis.conf', [
    '# generated by marina — edit, then: marina restart redis',
    'dir /old/.marina/data/redis/7',
    'logfile /old/.marina/etc/redis/7/redis.conf',
    'pidfile /old/.marina/run/redis-7.pid',
    '',
  ].join('\n'));
  assert.deepEqual(staleConfigReferencesWith(redisConf, 'redis', '7'), [
    '/old/.marina/data/redis/7',
    '/old/.marina/etc/redis/7/redis.conf',
    '/old/.marina/run/redis-7.pid',
  ]);

  const mongoConf = writeConf('mongod.conf', 'storage:\n  dbPath: /old/root/data/mongodb/7\n');
  assert.deepEqual(staleConfigReferencesWith(mongoConf, 'mongodb', '7'), ['/old/root/data/mongodb/7']);

  const mysqlConf = writeConf('my.cnf', '[mysqld]\nbasedir = /old/root/data/mysql/8.4/8.4.11\n');
  assert.deepEqual(staleConfigReferencesWith(mysqlConf, 'mysql', '8.4'), [
    '/old/root/data/mysql/8.4/8.4.11',
  ]);
});

test('staleConfigReferences keeps comments, relative and non-marina paths out', () => {
  const current = path.join(HOME, 'data', 'redis', '7');
  const file = writeConf('redis.conf', [
    '# dir /old/.marina/data/redis/7',
    `dir ${current}`,
    'dir /usr/lib/redis',
    'dir /old/myruntime/x',
    'dir relative/path',
    'dir /old/.marina/data/redis/8',
    'dir /old/.marina/data/redis/70',
    'bind 127.0.0.1',
    'dir /old/.marina/data/redis/7',
  ].join('\n'));
  assert.deepEqual(staleConfigReferencesWith(file, 'redis', '7'), ['/old/.marina/data/redis/7']);
});

function staleConfigReferencesWith(confFile, key, major) {
  return configcheck.staleConfigReferences({ confFile, key, major });
}

// ------------------------------------------------------------- settings ----

test('changeAccount keeps the old mysql credentials when the server ALTER fails', async () => {
  const root = path.join(HOME, 'engines', 'mysql', '8.4', '8.4.11');
  writeExecutable(path.join(root, 'bin', 'mysqld'), '#!/bin/sh\nexit 0\n');
  writeExecutable(path.join(root, 'bin', 'mysql'), '#!/bin/sh\nexit 1\n');
  state.setAccount('mysql', { user: 'root', password: 'oldpass' });

  const live = await listeningPort();
  const owner = spawnHold(root);
  state.setPort('mysql', '8.4', live.port);
  const ctx = registry.buildCtx(registry.engines.mysql, { major: '8.4', version: '8.4.11' });
  fs.mkdirSync(path.dirname(ctx.pidFile), { recursive: true });
  fs.writeFileSync(ctx.pidFile, String(owner.pid));
  try {
    const result = await settings.changeAccount(ctx, { password: 'newpass' });

    assert.deepEqual(result.account, { user: 'root', password: 'oldpass' });
    assert.deepEqual(result.applied, []);
    assert.match(result.notes.join(' '), /server password NOT changed/);
    assert.deepEqual(state.accountOf('mysql'), { user: 'root', password: 'oldpass' });
  } finally {
    await live.close();
    try { process.kill(owner.pid, 'SIGKILL'); } catch {}
    fs.rmSync(ctx.pidFile, { force: true });
  }
});

test('changeAccount persists the mysql password only after a successful ALTER', async () => {
  const root = path.join(HOME, 'engines', 'mysql', '8.4', '8.4.11');
  writeExecutable(path.join(root, 'bin', 'mysqld'), '#!/bin/sh\nexit 0\n');
  writeExecutable(path.join(root, 'bin', 'mysql'), '#!/bin/sh\nexit 0\n');
  state.setAccount('mysql', { user: 'root', password: 'oldpass' });

  const live = await listeningPort();
  const owner = spawnHold(root);
  state.setPort('mysql', '8.4', live.port);
  const ctx = registry.buildCtx(registry.engines.mysql, { major: '8.4', version: '8.4.11' });
  fs.mkdirSync(path.dirname(ctx.pidFile), { recursive: true });
  fs.writeFileSync(ctx.pidFile, String(owner.pid));
  try {
    const result = await settings.changeAccount(ctx, { password: 'newpass' });

    assert.deepEqual(result.account, { user: 'root', password: 'newpass' });
    assert.deepEqual(result.applied, ['server']);
    assert.deepEqual(state.accountOf('mysql'), { user: 'root', password: 'newpass' });
  } finally {
    await live.close();
    try { process.kill(owner.pid, 'SIGKILL'); } catch {}
    fs.rmSync(ctx.pidFile, { force: true });
  }
});

test('changeAccount keeps the old postgres password when ALTER ROLE fails', async () => {
  const root = path.join(HOME, 'engines', 'postgres', '17', '17.11');
  writeExecutable(path.join(root, 'bin', 'postgres'), '#!/bin/sh\nexit 0\n');
  writeExecutable(path.join(root, 'bin', 'psql'), '#!/bin/sh\nexit 1\n');
  state.setAccount('postgres', { user: 'postgres', password: 'oldpass' });

  const live = await listeningPort();
  const owner = spawnHold(root);
  state.setPort('postgres', '17', live.port);
  const ctx = registry.buildCtx(registry.engines.postgres, { major: '17', version: '17.11' });
  const pidFile = path.join(ctx.dataDir, 'postmaster.pid');
  fs.mkdirSync(ctx.dataDir, { recursive: true });
  fs.writeFileSync(pidFile, String(owner.pid));
  try {
    const result = await settings.changeAccount(ctx, { password: 'newpass' });

    assert.deepEqual(result.account, { user: 'postgres', password: 'oldpass' });
    assert.deepEqual(result.applied, []);
    assert.match(result.notes.join(' '), /server password NOT changed/);
    assert.deepEqual(state.accountOf('postgres'), { user: 'postgres', password: 'oldpass' });
  } finally {
    await live.close();
    try { process.kill(owner.pid, 'SIGKILL'); } catch {}
    fs.rmSync(pidFile, { force: true });
  }
});

test('changeAccount rolls redis state back when the config cannot be rewritten', async () => {
  state.setAccount('redis', { user: null, password: 'oldpass' });
  const root = tmp('redis-rollback');
  const engine = {
    key: 'redis',
    label: 'Redis',
    defaultPort: 6379,
    markers: ['bin/redis-server'],
    renderConfig() {
      throw new Error('boom while rendering');
    },
    probe: async () => false,
    readPid: () => null,
  };
  const ctx = {
    engine,
    key: 'redis',
    major: '7',
    version: '7.4.11',
    port: await freePort(),
    root,
    pidFile: path.join(root, 'redis.pid'),
    sockFile: path.join(root, 'redis.sock'),
    dataDir: path.join(root, 'data'),
    logDir: root,
    logFile: path.join(root, 'redis.log'),
    confFile: path.join(root, 'redis.conf'),
  };

  await assert.rejects(settings.changeAccount(ctx, { password: 'newpass' }), /boom while rendering/);
  assert.equal(state.accountOf('redis').password, 'oldpass', 'state must be rolled back');
});

// --------------------------------------------------------------- project ----

test('readProject rejects non-object pins and keeps the file path in the error', () => {
  const dir = tmp('marinarc');
  const file = path.join(dir, '.marinarc');
  for (const body of ['null', '[]', '"str"']) {
    fs.writeFileSync(file, body);
    assert.throws(() => project.readProject(file), (e) => {
      assert.ok(e.message.startsWith(`${file}: `), e.message);
      assert.match(e.message, /expected a JSON object of pins/);
      return true;
    });
  }

  fs.writeFileSync(file, JSON.stringify({ redis: '7.4.11' }));
  assert.deepEqual(project.readProject(file), { file, pins: { redis: '7.4.11' } });
});

// ------------------------------------------------------------ autostart ----

function fakeServiceManager({ bootoutFails = false } = {}) {
  const dir = tmp('fake-launchctl');
  const log = path.join(dir, 'calls.log');
  const script = path.join(dir, 'launchctl');
  fs.writeFileSync(
    script,
    [
      '#!/bin/sh',
      'printf \'%s\\n\' "$*" >> "$FAKE_SERVICE_LOG"',
      bootoutFails ? 'if [ "$1" = "bootout" ]; then exit 1; fi' : 'exit 0',
      'exit 0',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  return { dir, log };
}

async function withFakeLaunchctl(bootoutFails, fn) {
  const { dir, log } = fakeServiceManager({ bootoutFails });
  const saved = {
    path: process.env.PATH,
    log: process.env.FAKE_SERVICE_LOG,
    launchd: process.env.MARINA_LAUNCHD_DIR,
  };
  process.env.PATH = `${dir}${path.delimiter}${saved.path || ''}`;
  process.env.FAKE_SERVICE_LOG = log;
  process.env.MARINA_LAUNCHD_DIR = path.join(HOME, 'LaunchAgents');
  try {
    return await fn({ log, dir: process.env.MARINA_LAUNCHD_DIR });
  } finally {
    if (saved.path === undefined) delete process.env.PATH; else process.env.PATH = saved.path;
    if (saved.log === undefined) delete process.env.FAKE_SERVICE_LOG; else process.env.FAKE_SERVICE_LOG = saved.log;
    if (saved.launchd === undefined) delete process.env.MARINA_LAUNCHD_DIR; else process.env.MARINA_LAUNCHD_DIR = saved.launchd;
    state.setAutostart([]);
  }
}

test('disabling autostart falls back to `launchctl unload -w` and removes the plist', {
  skip: process.platform !== 'darwin' ? 'launchd only exists on macOS' : false,
}, async () => {
  await withFakeLaunchctl(true, async ({ log, dir }) => {
    state.setAutostart(['redis:7']);
    fs.mkdirSync(dir, { recursive: true });
    const plist = path.join(dir, 'com.marina.autostart.plist');
    fs.writeFileSync(plist, 'placeholder');

    const result = autostart.disableAll();
    assert.equal(result.enabled, false);
    assert.deepEqual(result.warnings, [], 'the fallback unload succeeded, so no warning');
    assert.equal(fs.existsSync(plist), false, 'the unit file must be removed');
    const calls = fs.readFileSync(log, 'utf8');
    assert.match(calls, /bootout /);
    assert.match(calls, /unload -w /);
  });
});

test('enabling autostart writes the unit once and keeps state idempotent', {
  skip: process.platform !== 'darwin' ? 'launchd only exists on macOS' : false,
}, async () => {
  await withFakeLaunchctl(false, async ({ dir }) => {
    const unit = autostart.enable([{ key: 'redis', major: '7' }]);
    const again = autostart.enable([{ key: 'redis', major: '7' }]);
    assert.equal(again.enabled, true);
    assert.deepEqual(state.autostartList(), ['redis:7']);
    assert.equal(fs.existsSync(unit.file), true);
    const text = fs.readFileSync(unit.file, 'utf8');
    assert.match(text, /<string>start<\/string>/);
    assert.match(text, /<string>--autostart<\/string>/);
    assert.equal(path.dirname(unit.file), dir);

    const disabled = autostart.disableAll();
    assert.equal(disabled.enabled, false);
    assert.equal(fs.existsSync(unit.file), false);
  });
});
