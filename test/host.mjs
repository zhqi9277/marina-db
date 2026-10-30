// Host backends as pure data: capabilities, shell text, Windows command-line
// identity, and autostart units. Nothing here starts a database or a service.
import assert from 'node:assert/strict';
import test from 'node:test';

import { darwin, linux, win32 } from '../src/host/index.js';
import { parseWinCommandLine, winProcessCommand } from '../src/host/win32.js';

const HOSTS = [linux, darwin, win32];

function redisCtx() {
  return {
    root: 'C:\\marina',
    dataDir: 'C:\\marina\\data\\redis\\7',
    confFile: 'C:\\marina\\etc\\redis\\7\\redis.conf',
    logFile: 'C:\\marina\\logs\\redis\\7.log',
    pidFile: 'C:\\marina\\run\\redis-7.pid',
    key: 'redis',
    major: '7',
    engine: { key: 'redis' },
  };
}

test('each host publishes a stable id, label, and capability set', () => {
  assert.deepEqual(
    HOSTS.map((item) => item.id),
    ['linux', 'darwin', 'win32'],
  );
  assert.deepEqual(
    HOSTS.map((item) => item.label),
    ['Linux', 'macOS', 'Windows'],
  );
  assert.deepEqual(linux.capabilities, { unixSocket: true, fork: true, posixSignals: true });
  assert.deepEqual(darwin.capabilities, linux.capabilities);
  assert.deepEqual(win32.capabilities, { unixSocket: false, fork: false, posixSignals: false });
  assert.equal(linux.pathCaseInsensitive, false);
  assert.equal(darwin.pathCaseInsensitive, false);
  assert.equal(win32.pathCaseInsensitive, true);
});

test('executable names, shims, and shellenv follow the host', () => {
  assert.equal(linux.exe('mysqld'), 'mysqld');
  assert.equal(darwin.exe('mysqld'), 'mysqld');
  assert.equal(win32.exe('mysqld'), 'mysqld.exe');

  assert.equal(linux.shimFileName('redis-cli'), 'redis-cli');
  assert.equal(win32.shimFileName('redis-cli'), 'redis-cli.cmd');
  assert.match(linux.shimScript('redis-cli', '/usr/bin/node', '/opt/marina/bin/marina.js'), /^#!\/bin\/sh/);
  assert.match(win32.shimScript('redis-cli', 'C:\\node.exe', 'C:\\marina\\bin\\marina.js'), /^@echo off/);
  assert.match(win32.shimScript('redis-cli', 'C:\\node.exe', 'C:\\marina\\bin\\marina.js'), /shim-exec "redis-cli" %\*/);

  assert.match(darwin.shellenv('/tmp/marina', '/tmp/marina/shims'), /^export MARINA_HOME=/);
  assert.match(darwin.shellenv('/tmp/marina', '/tmp/marina/shims'), /shims:\$PATH/);
  assert.match(win32.shellenv('C:\\marina', 'C:\\marina\\shims'), /\$env:PATH = "C:\\marina\\shims;\$env:PATH"/);
});

test('library inspectors are otool, ldd, or absent', () => {
  assert.deepEqual(darwin.libInspector(), { cmd: 'otool', args: ['-L'] });
  assert.deepEqual(linux.libInspector(), { cmd: 'ldd', args: [] });
  assert.equal(win32.libInspector(), null);
});

test('stop hints name the tool a person would run by hand', () => {
  assert.equal(linux.killHint(42), 'kill -9 42');
  assert.equal(darwin.killHint(42), 'kill -9 42');
  assert.equal(linux.forceVerb, 'SIGKILL');
  assert.equal(win32.killHint(42), 'taskkill /F /PID 42');
  assert.equal(win32.forceVerb, 'forced termination');
});

test('Windows command-line query only interpolates an integer pid', () => {
  assert.equal(winProcessCommand(0), null);
  assert.equal(winProcessCommand('12; Remove-Item C:\\'), null);
  const args = winProcessCommand(4242);
  assert.equal(args[0], '-NoProfile');
  assert.match(args[3], /ProcessId=4242/);
  assert.equal(args[3].includes('Remove-Item'), false);
});

test('parseWinCommandLine keeps the command and drops CIM whitespace', () => {
  assert.equal(parseWinCommandLine(''), null);
  assert.equal(parseWinCommandLine('  \r\n'), null);
  assert.deepEqual(parseWinCommandLine('C:\\mysql\\bin\\mysqld.exe --port 3306\r\n'), {
    command: 'C:\\mysql\\bin\\mysqld.exe --port 3306',
    cwd: null,
  });
});

test('Windows matches an install layout with either slash and any case', () => {
  const ctx = redisCtx();
  assert.equal(
    win32.matchesInstall(
      { command: 'C:\\marina\\engines\\redis\\7\\7.2.5\\redis-server.exe --port 6379', cwd: null },
      ctx,
    ),
    true,
  );
  assert.equal(
    win32.matchesInstall(
      { command: 'C:/MARINA/ENGINES/redis/7/redis-server.exe', cwd: null },
      ctx,
    ),
    true,
  );
  assert.equal(
    win32.matchesInstall(
      { command: 'D:\\old\\engines\\redis\\7\\redis-server.exe', cwd: null },
      ctx,
    ),
    true,
  );
  assert.equal(
    win32.matchesInstall({ command: null, cwd: 'D:\\old\\data\\redis\\7' }, ctx),
    true,
  );
  assert.equal(
    win32.matchesInstall(
      { command: 'C:\\Program Files\\MySQL\\bin\\mysqld.exe --datadir=C:\\ProgramData\\MySQL', cwd: null },
      ctx,
    ),
    false,
  );
  assert.equal(win32.matchesInstall({ command: null, cwd: null }, ctx), true);
});

test('POSIX matching still rejects a system binary', () => {
  const ctx = {
    root: '/opt/marina',
    dataDir: '/opt/marina/data/redis/7',
    confFile: '/opt/marina/etc/redis/7/redis.conf',
    logFile: '/opt/marina/logs/redis/7.log',
    pidFile: '/opt/marina/run/redis-7.pid',
    key: 'redis',
    major: '7',
    engine: { key: 'redis' },
  };
  assert.equal(
    darwin.matchesInstall(
      { command: '/opt/marina/engines/redis/7/7.2.5/bin/redis-server', cwd: null },
      ctx,
    ),
    true,
  );
  assert.equal(
    linux.matchesInstall(
      { command: '/usr/local/bin/mysqld --datadir=/var/lib/mysql', cwd: null },
      ctx,
    ),
    false,
  );
});

test('zip extraction falls back to PowerShell only on Windows zip payloads', () => {
  assert.equal(darwin.zipExtractArgs('mysql.zip', 'C:\\out'), null);
  assert.equal(win32.zipExtractArgs('mysql.tar.gz', 'C:\\out'), null);
  const fallback = win32.zipExtractArgs('mysql.zip', 'C:\\out');
  assert.equal(fallback.cmd, 'powershell');
  assert.match(fallback.args.at(-1), /Expand-Archive/);
  assert.match(fallback.args.at(-1), /-ErrorAction Stop/);
});

test('autostart units are launchd, systemd --user, and a logon scheduled task', () => {
  const node = 'C:\\Program Files\\node&co\\node.exe';
  const cli = 'C:\\marina\\bin\\marina.js';
  const ctx = { node, cli, log: 'C:\\marina\\logs\\autostart.log' };

  const plist = darwin.renderUnit(['mysql:8.4'], darwin.unitTarget(), ctx);
  assert.match(plist, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(plist, /com\.marina\.autostart/);

  const unit = linux.renderUnit(['redis:7'], linux.unitTarget(), { node: '/usr/bin/node', cli: '/opt/marina%/bin/marina.js', log: '/tmp/autostart.log' });
  assert.match(unit, /WantedBy=default\.target/);
  assert.match(unit, /ExecStart="\/usr\/bin\/node" "\/opt\/marina%%\/bin\/marina.js" start --autostart/);

  const xml = win32.renderUnit(['redis:7', 'mysql:8.4'], win32.unitTarget(), ctx);
  assert.match(xml, /<LogonTrigger>/);
  assert.match(xml, /marina autostart databases \(redis:7, mysql:8\.4\)/);
  assert.ok(xml.includes('C:\\Program Files\\node&amp;co\\node.exe'));
  assert.match(xml, /start --autostart/);
  assert.equal(xml.includes('node&co'), false);

  const calls = [];
  const run = (cmd, args) => {
    calls.push({ cmd, args });
    return { ok: true, skipped: false };
  };
  const target = win32.unitTarget();
  win32.loadAutostart(target, run);
  win32.unloadAutostart(target, run);
  assert.deepEqual(calls[0], {
    cmd: 'schtasks',
    args: ['/Create', '/TN', 'marina-autostart', '/XML', target.file, '/F'],
  });
  assert.deepEqual(calls[1], {
    cmd: 'schtasks',
    args: ['/Delete', '/TN', 'marina-autostart', '/F'],
  });
});
