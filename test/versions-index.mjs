import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'marina-versions-'));
process.env.MARINA_HOME = home;
const { listVersions, resolveVersion } = await import('../src/install/versions.js');
const { parseCatalog } = await import('../src/install/overlay.js');
const { resolveTarget } = await import('../src/install/installer.js');
const { engines } = await import('../src/core/registry.js');

const artifact = (name, version, options = {}) => ({
  name, version, os: process.platform, arch: process.arch,
  size: 1024, sha256: 'abcd'.repeat(16), url: 'https://example.test/engine.tar.gz',
  ...options,
});
const catalog = {
  schema: 1,
  artifacts: [
    artifact('mysql', '9.1.0'),
    artifact('mysql', '8.4.9'),
    artifact('mysql', '8.4.11'),
    artifact('mysql', '8.4.13', { arch: process.arch === 'x64' ? 'arm64' : 'x64' }),
    artifact('postgres', '17.11', { major: '17.11' }),
  ],
};

after(() => fs.rmSync(home, { recursive: true, force: true }));

test('catalog validates SHA-256, size and duplicate normalized targets', () => {
  assert.throws(() => parseCatalog([artifact('redis', '7.4.11', { sha256: 'bad' })]), /invalid catalog artifact/);
  assert.throws(() => parseCatalog([artifact('redis', '7.4.11', { size: 0 })]), /invalid catalog artifact/);
  const row = artifact('postgres', '17.11', { os: 'windows', arch: 'x86_64' });
  const alias = { ...row, name: 'postgresql', os: 'win32', arch: 'x64' };
  assert.throws(() => parseCatalog([row, alias]), /duplicate catalog artifact/);
});

test('list, default selection and explicit install share one platform-filtered catalog', async () => {
  const file = path.join(home, 'manifest.json');
  fs.writeFileSync(file, JSON.stringify(catalog));
  process.env.MARINA_CATALOG_FILE = file;
  process.env.MARINA_CATALOG_URL = 'http://127.0.0.1:1/unused';

  try {
    const index = await listVersions('mysql');
    assert.equal(index.source, file);
    assert.deepEqual(index.versions.map((v) => v.version), ['9.1.0', '8.4.11', '8.4.9']);
    assert.ok(index.versions.every((v) => v.supported && v.kind === 'binary'));
    assert.equal((await resolveVersion(engines.mysql)).version, '8.4.11');
    assert.equal((await resolveVersion(engines.mysql, 'latest')).version, '9.1.0');
    assert.equal((await resolveVersion(engines.mysql, '8.4')).version, '8.4.11');
    assert.equal((await resolveVersion(engines.mysql, '8.4.9')).version, '8.4.9');
    const postgres = await resolveTarget('postgres@17');
    assert.equal(postgres.major, '17');
    assert.equal(postgres.size, 1024);
    assert.equal(postgres.channel, 'catalog');

    await assert.rejects(resolveTarget('mysql@8.4.13'), /no published build.*available: 9\.1\.0, 8\.4\.11, 8\.4\.9/);
    await assert.rejects(resolveTarget('redis'), /no published build.*available: none/);
    assert.equal((await resolveTarget('redis@7', { file: 'redis-7.4.10.tar.gz' })).version, '7.4.10');
  } finally {
    delete process.env.MARINA_CATALOG_FILE;
    delete process.env.MARINA_CATALOG_URL;
  }
});

test('remote queries and install resolution read the current catalog without disk fallback', async () => {
  const requests = [];
  let served = catalog;
  const server = http.createServer((req, res) => {
    requests.push({ url: req.url, cacheControl: req.headers['cache-control'] });
    res.statusCode = served ? 200 : 503;
    res.end(JSON.stringify(served));
  });
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const requestPath = '/manifest.json?key=fixture';
  const url = 'http://127.0.0.1:' + server.address().port + requestPath;
  const oldDir = path.join(home, 'cache', 'index');
  const oldFile = 'catalog-' + createHash('sha256').update(url).digest('hex') + '.json';
  const old = JSON.stringify({ fetchedAt: Date.now(), artifacts: [artifact('mysql', '8.4.1')] });
  fs.mkdirSync(oldDir, { recursive: true });
  fs.writeFileSync(path.join(oldDir, oldFile), old);

  process.env.MARINA_CATALOG_URL = url;
  try {
    const bin = fileURLToPath(new URL('../bin/marina.js', import.meta.url));
    const { stdout } = await promisify(execFile)(process.execPath, [bin, 'remote', '--json']);
    const indexes = JSON.parse(stdout);
    assert.deepEqual(indexes.mysql.versions.map((entry) => entry.version), ['9.1.0', '8.4.11', '8.4.9']);
    assert.equal(indexes.postgres.versions[0].version, '17.11');
    assert.equal(requests.length, 1);

    served = { artifacts: [artifact('mysql', '8.4.12')] };
    assert.equal((await listVersions('mysql')).versions[0].version, '8.4.12');
    served = { artifacts: [artifact('mysql', '8.4.14')] };
    assert.equal((await resolveTarget('mysql@8.4')).version, '8.4.14');
    served = null;
    await assert.rejects(listVersions('mysql'), /engine catalog.*HTTP 503/);
    assert.equal(requests.length, 4);
    assert.ok(requests.every((req) => req.url === requestPath && req.cacheControl === 'no-cache, no-store'));
    assert.deepEqual(fs.readdirSync(oldDir), [oldFile]);
    assert.equal(fs.readFileSync(path.join(oldDir, oldFile), 'utf8'), old);
  } finally {
    delete process.env.MARINA_CATALOG_URL;
    await new Promise((resolve) => server.close(resolve));
  }
});
