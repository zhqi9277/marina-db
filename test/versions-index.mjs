import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'marina-versions-'));
process.env.MARINA_HOME = home;
const { listVersions, resolveVersion, indexCacheInfo } = await import('../src/install/versions.js');
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

test('remote cache is shared across engines, isolated by URL and bypassed on refresh', async () => {
  let requests = 0;
  const server = http.createServer((_req, res) => {
    requests++;
    res.end(JSON.stringify(catalog));
  });
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + server.address().port + '/manifest.json';
  process.env.MARINA_CATALOG_URL = url;
  delete process.env.MARINA_INDEX_TTL;
  try {
    await Promise.all([listVersions('mysql'), listVersions('postgres')]);
    assert.equal(requests, 1);
    assert.deepEqual(indexCacheInfo().engines.sort(), ['mysql', 'postgres']);
    await listVersions('mysql');
    assert.equal(requests, 1);
    await listVersions('mysql', { refresh: true });
    assert.equal(requests, 2);
    process.env.MARINA_CATALOG_URL = url + '?another';
    await listVersions('mysql');
    assert.equal(requests, 3);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  try {
    process.env.MARINA_CATALOG_URL = url;
    process.env.MARINA_INDEX_TTL = '0';
    assert.equal((await listVersions('mysql')).stale, true);
    await assert.rejects(listVersions('mysql', { refresh: true }), /engine catalog/);
  } finally {
    delete process.env.MARINA_CATALOG_URL;
    delete process.env.MARINA_INDEX_TTL;
  }
});
