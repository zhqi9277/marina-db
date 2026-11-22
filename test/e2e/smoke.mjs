// Verify one matrix entry with a disposable home and the CLI's download path.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { archiveName, catalogArtifact, describeArchive } from '../../scripts/make-manifest.mjs';
import { tcpProbe } from '../../src/runtime/lifecycle.js';

const [engine, version, archiveDir, evidenceDir] = process.argv.slice(2);
const catalogUrl = process.env.MARINA_CATALOG_URL;
assert.ok(engine && version, 'usage: npm run smoke:e2e -- <engine> <version> [archive directory] [evidence directory]');
assert.ok(archiveDir || catalogUrl || process.env.MARINA_CATALOG_FILE, 'a candidate archive or catalog is required');
const windows = process.platform === 'win32';
const home = fs.mkdtempSync(path.join(windows ? os.tmpdir() : '/tmp', 'marina test-'));
const bin = fileURLToPath(new URL('../../bin/marina.js', import.meta.url));
const env = { ...process.env, MARINA_HOME: home };
for (const key of Object.keys(env)) {
  if (key.toUpperCase() === 'PATH') delete env[key];
}
const system = process.env.SystemRoot || 'C:\\Windows';
env.PATH = windows
  ? [path.join(system, 'System32'), path.join(system, 'System32', 'WindowsPowerShell', 'v1.0'), system].join(';')
  : '/usr/bin:/bin:/usr/sbin:/sbin';

function cli(...args) {
  const result = spawnSync(process.execPath, [bin, ...args], {
    cwd: home, env, encoding: 'utf8', timeout: 600000, maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, 'marina ' + args.join(' ') + '\n' + result.stderr + '\n' + result.stdout);
  return result.stdout.trim();
}

function command(ref, ...args) {
  return cli('exec', ref, '--', ...args);
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

function memcached(port, request) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(request + 'quit\r\n'));
    let response = '';
    socket.setEncoding('utf8');
    socket.setTimeout(3000, () => socket.destroy(new Error('Memcached request timed out')));
    socket.on('data', (data) => { response += data; });
    socket.on('end', () => resolve(response));
    socket.on('error', reject);
  });
}

function sql(ref, text) {
  return engine === 'postgres'
    ? command(ref, '-Atc', text)
    : command(ref, '-N', '-B', '-e', text);
}

async function vectorRequest(port, endpoint, method = 'GET', payload) {
  const response = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
    method,
    headers: { 'Content-Type': 'application/json', Connection: 'close' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(60000),
  });
  const text = await response.text();
  assert.ok(response.ok, `${method} ${endpoint}: HTTP ${response.status} ${text}`);
  return JSON.parse(text);
}

async function milvusRequest(port, action, payload) {
  const result = await vectorRequest(port, '/v2/vectordb/' + action, 'POST', payload);
  assert.equal(result.code, 0, action + ' ' + JSON.stringify(result));
  return result.data;
}

async function waitForMilvusCollection(port) {
  const deadline = Date.now() + 60000;
  do {
    const state = await milvusRequest(port, 'collections/get_load_state', { collectionName: 'marina' });
    if (state.loadState === 'LoadStateLoaded') return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  } while (Date.now() < deadline);
  assert.fail('Milvus did not load the collection');
}

async function readVersion(ref, port) {
  switch (engine) {
    case 'mysql':
    case 'mariadb': return sql(ref, 'SELECT VERSION();');
    case 'postgres': return sql(ref, 'SHOW server_version;');
    case 'mongodb': return command(ref, '--quiet', '--norc', '--eval', 'db.version()');
    case 'redis': return command(ref, 'info').match(/^redis_version:(.+)$/m)?.[1];
    case 'memcached': return (await memcached(port, 'version\r\n')).trim().replace(/^VERSION /, '');
    case 'qdrant': return (await vectorRequest(port, '/')).version;
    case 'milvus': {
      const log = path.join(home, 'logs', 'milvus', version.split('.')[0] + '.log');
      return fs.readFileSync(log, 'utf8').match(/^Version:\s+([^\s]+)/m)?.[1];
    }
  }
}

async function write(ref, port) {
  switch (engine) {
    case 'mysql':
    case 'mariadb':
      sql(ref, 'CREATE DATABASE smoke; CREATE TABLE smoke.marina (value INTEGER); INSERT INTO smoke.marina VALUES (42);');
      break;
    case 'postgres':
      sql(ref, 'CREATE TABLE marina (value INTEGER); INSERT INTO marina VALUES (42);');
      break;
    case 'redis':
      assert.equal(command(ref, 'set', 'marina', '42'), 'OK');
      break;
    case 'mongodb':
      assert.equal(command(ref, '--quiet', '--norc', '--eval',
        'db.getSiblingDB("marina").smoke.insertOne({_id:"row", value:42}).acknowledged'), 'true');
      break;
    case 'memcached':
      assert.equal(await memcached(port, 'set marina 0 0 2\r\n42\r\n'), 'STORED\r\n');
      break;
    case 'qdrant':
      await vectorRequest(port, '/collections/marina', 'PUT', { vectors: { size: 3, distance: 'Cosine' } });
      await vectorRequest(port, '/collections/marina/points?wait=true', 'PUT', {
        points: [{ id: 42, vector: [1, 0, 0] }, { id: 24, vector: [0, 1, 0] }],
      });
      break;
    case 'milvus':
      await milvusRequest(port, 'collections/create', {
        collectionName: 'marina', dimension: 3, idType: 'Int64', metricType: 'COSINE',
        primaryFieldName: 'id', vectorFieldName: 'vector', autoID: false,
      });
      await waitForMilvusCollection(port);
      await milvusRequest(port, 'entities/insert', {
        collectionName: 'marina',
        data: [{ id: 42, vector: [1, 0, 0] }, { id: 24, vector: [0, 1, 0] }],
      });
      break;
    default:
      throw new Error('unknown engine ' + engine);
  }
}

async function read(ref, port, restarted) {
  switch (engine) {
    case 'mysql':
    case 'mariadb':
      assert.equal(sql(ref, 'SELECT value FROM smoke.marina;'), '42');
      break;
    case 'postgres':
      assert.equal(sql(ref, 'SELECT value FROM marina;'), '42');
      break;
    case 'redis':
      assert.equal(command(ref, 'get', 'marina'), '42');
      break;
    case 'mongodb':
      assert.equal(command(ref, '--quiet', '--norc', '--eval',
        'db.getSiblingDB("marina").smoke.findOne({_id:"row"}).value'), '42');
      break;
    case 'memcached':
      assert.equal(await memcached(port, 'get marina\r\n'), restarted ? 'END\r\n' : 'VALUE marina 0 2\r\n42\r\nEND\r\n');
      break;
    case 'qdrant': {
      const { result } = await vectorRequest(port, '/collections/marina/points/query', 'POST', { query: [1, 0, 0], limit: 1 });
      assert.equal(result.points[0].id, 42);
      break;
    }
    case 'milvus': {
      await waitForMilvusCollection(port);
      const rows = await milvusRequest(port, 'entities/search', {
        collectionName: 'marina', data: [[1, 0, 0]], annsField: 'vector', consistencyLevel: 'Strong', limit: 1,
      });
      assert.equal(Number(rows[0].id), 42);
      break;
    }
  }
}

let ref = engine + '@' + version;
let failure;
let server;
let archive;
try {
  const expected = process.env.MARINA_CATALOG_SHA256;
  if (archiveDir) {
    const target = { engine, version, os: process.platform, arch: process.arch };
    const file = path.join(archiveDir, archiveName(target));
    archive = await describeArchive(file, target);
    server = new Worker(new URL('./serve-engine-archive.mjs', import.meta.url), { workerData: { file, ...archive } });
    const url = await new Promise((resolve, reject) => {
      server.once('message', resolve);
      server.once('error', reject);
    });
    env.MARINA_CATALOG_FILE = path.join(home, 'candidate.json');
    fs.writeFileSync(env.MARINA_CATALOG_FILE, JSON.stringify({ schema: 1, artifacts: [catalogArtifact(target, archive, url)] }));
  } else if (expected) {
    const response = await fetch(catalogUrl, { signal: AbortSignal.timeout(30000) });
    assert.ok(response.ok, 'candidate catalog returned HTTP ' + response.status);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), expected);
    env.MARINA_CATALOG_FILE = path.join(home, 'candidate.json');
    fs.writeFileSync(env.MARINA_CATALOG_FILE, bytes);
  }

  const port = await freePort();
  const index = JSON.parse(cli('remote', engine, '--json'));
  assert.ok(index.versions.some((row) => row.version === version && row.supported), 'missing build for this host');
  assert.equal(JSON.parse(cli('install', ref, '--port', String(port), '--json')).version, version);
  assert.equal(await tcpProbe(port), false, 'installation left the engine running');
  cli('start', ref);
  const status = JSON.parse(cli('status', ref, '--json'));
  assert.ok((Array.isArray(status) ? status[0] : status)?.healthy, 'engine did not become healthy');
  const actual = await readVersion(ref, port);
  assert.ok(actual?.match(/\d+\.\d+(?:\.\d+)?/g)?.includes(version),
    'expected server version ' + version + ', received ' + actual);
  await write(ref, port);
  await read(ref, port, false);
  cli('restart', ref);
  await read(ref, port, true);
  if (engine === 'mysql' && version.startsWith('5.6.')) {
    cli('auth', ref, 'marina_legacy', "legacy'password");
    await read(ref, port, true);
    cli('auth', ref, 'marina_legacy', 'updated-password');
    await read(ref, port, true);
  }
  cli('stop', ref);
  assert.equal(await tcpProbe(port), false, 'stop left the listener open');
  console.log('[ok] ' + ref + ' ' + process.platform + '/' + process.arch);
} catch (error) {
  failure = error;
  throw error;
} finally {
  try {
    cli('stop', ref);
  } catch (error) {
    if (failure) console.error('Cleanup:', error.message);
    else throw error;
  } finally {
    if (server) await server.terminate();
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 });
  }
}
if (archive && evidenceDir) {
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(path.join(evidenceDir, archive.fileName + '.json'), JSON.stringify(archive) + '\n');
}
