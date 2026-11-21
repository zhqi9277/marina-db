// Version index cache + resolution. All network use is avoided by writing a
// fresh cache entry (TTL is pinned) and only exercising offline branches.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'marina-versions-'));
process.env.MARINA_HOME = HOME;
process.env.MARINA_INDEX_TTL = '21600'; // 6h, so fresh fixtures are always reused

const versions = await import('../src/install/versions.js');
const { engines } = await import('../src/core/registry.js');
const { platformProblem } = await import('../src/install/catalog.js');

const { readCache, writeCache, cacheFile } = versions._internal;
const INDEX_DIR = path.join(HOME, 'cache', 'index');

after(() => fs.rmSync(HOME, { recursive: true, force: true }));

test('cacheFile is keyed by engine, platform and arch under cache/index', () => {
  const file = cacheFile('mysql');
  assert.equal(path.dirname(file), INDEX_DIR);
  assert.equal(path.basename(file), `mysql.${process.platform}.${process.arch}.json`);
});

test('writeCache/readCache round-trip a payload', () => {
  const payload = { engine: 'redis', source: 'fixture', fetchedAt: 111, versions: [] };
  writeCache('redis', payload);
  assert.deepEqual(readCache('redis'), payload);
  // unreadable/corrupt entries read as null
  fs.writeFileSync(path.join(INDEX_DIR, 'broken.json'), '{not json');
  assert.equal(readCache('broken'), null);
});

test('indexCacheInfo counts cache files, engines and the newest fetchedAt', () => {
  const info = versions.indexCacheInfo();
  assert.equal(info.files, 2);
  assert.deepEqual([...info.engines].sort(), ['broken', 'redis']);
  assert.equal(info.newest, 111); // the corrupt file contributes no timestamp
});

test('getIndex reuses a fresh cache and decorates platform availability', async () => {
  writeCache('mysql', {
    engine: 'mysql',
    source: 'fixture',
    fetchedAt: Date.now(),
    versions: [
      { version: '8.4.11', major: '8.4', kind: 'binary', urls: ['u'], platformKnown: true },
      { version: '8.0.25', major: '8.0', kind: 'binary', urls: [], platformKnown: true },
      { version: '8.0.29', major: '8.0', kind: 'binary', urls: ['u'], platformKnown: true },
    ],
  });
  const index = await versions.getIndex('mysql');
  assert.equal(index.source, 'fixture');
  assert.equal(index.stale, false);
  assert.deepEqual(index.versions.map((v) => v.version), ['8.4.11', '8.0.25', '8.0.29']);
  assert.deepEqual(index.versions.map((v) => v.supported), [true, false, true]);
  assert.match(index.versions[1].reason, /build for this version/);
});

test('getIndex rejects an unknown engine before touching the network', async () => {
  await assert.rejects(versions.getIndex('oracle'), /unknown database "oracle"/);
});

test('resolveVersion honours exact versions, major lines and the supported pool', async () => {
  const exact = await versions.resolveVersion(engines.mysql, '8.4.11');
  assert.equal(exact.version, '8.4.11');
  assert.equal(exact.supported, true);
  assert.equal(exact.stale, false);
  assert.equal(exact.indexSource, 'fixture');

  // 8.0.25 is indexed but has no artifact on this platform, so "8.0" resolves
  // to the newest usable version inside the line
  const major = await versions.resolveVersion(engines.mysql, '8.0');
  assert.equal(major.version, '8.0.29');

  const unsupportedExact = await versions.resolveVersion(engines.mysql, '8.0.25');
  assert.equal(unsupportedExact.version, '8.0.25');
  assert.equal(unsupportedExact.supported, false);
  await assert.rejects(versions.resolveVersion(engines.mysql, '8.0.99'), /8\.0\.99 is not in the remote index/);

  await assert.rejects(versions.resolveVersion(engines.mysql, '9.9'), (e) => {
    assert.match(e.message, /MySQL 9\.9 is not in the remote index/);
    assert.match(e.message, /newest: /);
    assert.match(e.message, /hint: marina remote mysql --refresh/);
    return true;
  });
});

test('resolveVersion reports an empty remote index', async () => {
  writeCache('memcached', { engine: 'memcached', source: 'fixture', fetchedAt: Date.now(), versions: [] });
  await assert.rejects(versions.resolveVersion(engines.memcached, null), /Memcached: the remote index is empty/);
});

test('resolveVersion falls back to unsupported entries when nothing is supported', async () => {
  writeCache('mysql', {
    engine: 'mysql',
    source: 'fixture',
    fetchedAt: Date.now(),
    versions: [{ version: '8.4.11', major: '8.4', kind: 'binary', urls: [], platformKnown: true }],
  });
  const hit = await versions.resolveVersion(engines.mysql, '8.4');
  assert.equal(hit.version, '8.4.11');
  assert.equal(hit.supported, false);
  assert.match(hit.reason, /build for this version/);
});

test('resolveArtifact keeps every candidate URL and does not probe first', async () => {
  const result = await versions.resolveArtifact({
    version: '1.2.3',
    urls: ['https://one.test/a.tar.gz', 'https://two.test/a.tar.gz'],
  }, { engine: 'redis' });
  assert.deepEqual(result.urls, ['https://one.test/a.tar.gz', 'https://two.test/a.tar.gz']);
  assert.equal(result.url, 'https://one.test/a.tar.gz');
});

test('resolveArtifact fails closed when a declared checksum response has no hash', async () => {
  const server = http.createServer((_req, res) => res.end('checksum unavailable'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    await assert.rejects(
      versions._internal.loadChecksum(
        { sha256Url: `http://127.0.0.1:${port}/missing.sha256` },
        `http://127.0.0.1:${port}/a.tar.gz`,
      ),
      /no sha256 found/,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('resolveArtifact explains when no artifact is known instead of probing', async () => {
  await assert.rejects(
    versions.resolveArtifact({ version: '1.2.3', urls: [] }, { engine: 'redis' }),
    (e) => {
      assert.match(e.message, /no .* artifact is known for 1\.2\.3/);
      assert.match(e.message, /hint: marina remote redis --refresh/);
      return true;
    },
  );
});

test('_internal.decorate reflects MariaDB support on the current host', () => {
  const [entry] = versions._internal.decorate('mariadb', [
    { version: '11.4.13', major: '11.4', kind: 'source', urls: ['u'], platformKnown: false },
  ]);
  const problem = platformProblem('mariadb');
  assert.equal(entry.supported, problem === null);
  assert.equal(entry.reason, problem);
});
