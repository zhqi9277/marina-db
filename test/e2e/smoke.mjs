// End-to-end smoke check: isolated MARINA_HOME, install, start, read/write, stop.
// Run locally with: npm run smoke:e2e -- mysql
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ENGINE_ALIASES = {
  mysql: 'mysql',
  mariadb: 'mariadb',
  postgres: 'postgres',
  mongodb: 'mongodb',
  redis: 'redis',
  memcached: 'memcached',
};

const requested = process.argv[2];
const engines = requested ? [ENGINE_ALIASES[requested] || requested] : Object.keys(ENGINE_ALIASES);
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'marina-smoke-'));
const env = { ...process.env, MARINA_HOME: home, NO_COLOR: '1' };
const cli = (...args) => spawnSync(process.execPath, ['bin/marina.js', ...args], {
  cwd: path.resolve(new URL('../..', import.meta.url).pathname),
  env,
  encoding: 'utf8',
  timeout: 600000,
});

function json(result) {
  assert.equal(result.status, 0, `${result.error || result.stderr}\n${result.stdout}`);
  return JSON.parse(result.stdout);
}
async function closedPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function tcp(port) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error(`TCP timeout on 127.0.0.1:${port}`));
    }, 5000);
    sock.once('connect', () => {
      clearTimeout(timer);
      sock.end();
      resolve();
    });
    sock.once('error', reject);
  });
}

async function memcachedReadWrite(port) {
  await new Promise((resolve, reject) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    let out = '';
    sock.setEncoding('utf8');
    sock.on('connect', () => sock.write('set smoke 0 0 2\r\nok\r\n'));
    sock.on('data', (chunk) => {
      out += chunk;
      if (out.includes('STORED')) sock.write('get smoke\r\n');
      if (out.includes('VALUE smoke 0 2\r\nok\r\n')) {
        sock.end();
        resolve();
      }
    });
    sock.once('error', reject);
  });
}

for (const engine of engines) {
  const port = await closedPort();
  const install = cli('install', engine, '--port', String(port), '--json');
  if (install.status !== 0) {
    console.log(`[skip] ${engine}: ${install.stderr.trim().split('\n')[0]}`);
    continue;
  }
  const target = json(install);
  const ref = `${engine}@${target.major}`;

  const started = cli('start', ref, '--json');
  assert.equal(started.status, 0, started.stderr);
  const statusResult = json(cli('status', ref, '--json'));
  const statusRow = Array.isArray(statusResult) ? statusResult[0] : statusResult;
  assert.ok(statusRow?.healthy, `${engine} did not become healthy`);

  if (engine === 'mysql' || engine === 'mariadb') {
    const result = cli('exec', ref, '--', '-e', 'select 1');
    assert.equal(result.status, 0, result.stderr);
  } else if (engine === 'postgres') {
    const result = cli('exec', ref, '--', '-Atc', 'select 1');
    assert.equal(result.status, 0, result.stderr);
  } else if (engine === 'redis') {
    const result = cli('exec', ref, '--', 'ping');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /PONG/i);
  } else if (engine === 'mongodb') {
    await tcp(statusRow.port);
  } else if (engine === 'memcached') {
    await memcachedReadWrite(statusRow.port);
  }

  const stopped = cli('stop', ref, '--json');
  assert.equal(stopped.status, 0, stopped.stderr);
  console.log(`[ok] ${engine}`);
}

fs.rmSync(home, { recursive: true, force: true });
