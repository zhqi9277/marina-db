// Offline tests for remote index parsing. No network, only fixtures.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  parseHrefs,
  versionsFromListing,
  mysqlUrlsForVersion,
  mongoVersionEntries,
  PROFILES,
  sortVersionsDesc,
} from '../src/indexing.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => fs.readFileSync(path.join(DIR, 'fixtures', name), 'utf8');

test('parseHrefs extracts directories and files, skipping nav junk', () => {
  const hrefs = parseHrefs(fixture('postgres-source.html'));
  assert.deepEqual(hrefs.map((h) => h.name), ['v18beta1', 'v17.11', 'v17.10', 'v16.9', 'v9.6.24']);
  assert.equal(hrefs.find((h) => h.name === 'v17.11').dir, true);
});

test('postgres listing: versions, major, artifact and checksum URLs', () => {
  const source = { name: 'aliyun', base: 'https://mirror.test/postgresql/source/' };
  const versions = versionsFromListing('postgres', PROFILES.postgres, source, parseHrefs(fixture('postgres-source.html')));
  assert.deepEqual(versions.map((v) => v.version), ['17.11', '17.10', '16.9', '9.6.24']);
  assert.equal(versions[0].major, '17');
  assert.equal(versions[0].kind, 'source');
  assert.equal(versions[0].source, 'aliyun');
  assert.equal(versions[0].urls[0], 'https://mirror.test/postgresql/source/v17.11/postgresql-17.11.tar.gz');
  assert.equal(versions[0].sha256Url, 'https://mirror.test/postgresql/source/v17.11/postgresql-17.11.tar.gz.sha256');
});

test('redis listing: only release tarballs, no checksum sidecars', () => {
  const source = { name: 'huawei', base: 'https://mirror.test/redis/' };
  const versions = versionsFromListing('redis', PROFILES.redis, source, parseHrefs(fixture('redis.html')));
  assert.deepEqual(versions.map((v) => v.version), ['8.10.2', '7.4.11', '7.2.5']);
  assert.equal(versions[0].urls[0], 'https://mirror.test/redis/redis-8.10.2.tar.gz');
});

test('mariadb listing: skips rc/preview directories', () => {
  const source = { name: 'tencent', base: 'https://mirror.test/mariadb/' };
  const versions = versionsFromListing('mariadb', PROFILES.mariadb, source, parseHrefs(fixture('mariadb.html')));
  assert.deepEqual(versions.map((v) => v.version), ['11.8.9', '11.4.13', '10.6.28']);
  assert.equal(
    versions.find((v) => v.version === '11.4.13').urls[0],
    'https://mirror.test/mariadb/mariadb-11.4.13/source/mariadb-11.4.13.tar.gz',
  );
  assert.match(versions[0].sha256File, /sha256sums\.txt$/);
});

test('memcached listing', () => {
  const source = { name: 'huawei', base: 'https://mirror.test/memcached/' };
  const versions = versionsFromListing('memcached', PROFILES.memcached, source, parseHrefs(fixture('memcached.html')));
  assert.deepEqual(versions.map((v) => v.version), ['1.6.45', '1.6.44']);
});

test('mysql listing: picks the artifact for the current platform/arch', () => {
  const base = 'https://mirror.test/mysql/MySQL-8.0/';
  const files = parseHrefs(fixture('mysql-8.0.html'))
    .filter((h) => !h.dir)
    .map((h) => ({ name: h.name, url: new URL(h.href, base).href }));

  const urls = mysqlUrlsForVersion(files, '8.0.28');
  if (process.platform === 'darwin' && process.arch === 'arm64') {
    assert.match(urls[0], /macos12-arm64\.tar\.gz$/);
  } else if (process.platform === 'darwin') {
    assert.match(urls[0], /macos11-x86_64\.tar\.gz$/);
  } else if (process.platform === 'linux' && process.arch === 'arm64') {
    assert.match(urls[0], /glibc2\.28-aarch64\.tar\.xz$/);
  } else if (process.platform === 'linux') {
    assert.match(urls[0], /glibc2\.17-x86_64\.tar\.xz$/);
  } else if (process.platform === 'win32') {
    assert.match(urls[0], /winx64\.zip$/);
  }
});

test('mysql 8.4 discovery from the tag feed ignores cluster tags', () => {
  const atom = fixture('mysql-tags.atom');
  const tags = [...atom.matchAll(/<title>mysql-(\d+\.\d+\.\d+)(?::[^<]*)?<\/title>/g)].map((m) => m[1]);
  assert.deepEqual(tags, ['8.4.11', '9.7.2']);
});

test('mongodb index: base editions only, per-platform artifact, sha256 carried', () => {
  const entries = mongoVersionEntries(JSON.parse(fixture('mongo.json')));
  assert.deepEqual(entries.map((e) => e.version), ['7.0.45']); // rc is skipped
  const entry = entries[0];
  assert.equal(entry.kind, 'binary');
  assert.equal(entry.sha256.length, 64);
  if (process.platform === 'darwin') assert.match(entry.urls[0], /macos-arm64|macos-x86_64/);
  if (process.platform === 'linux') assert.match(entry.urls[0], /ubuntu2204/);
  if (process.platform === 'win32') assert.match(entry.urls[0], /windows/);
});

test('versions sort numerically, not lexicographically', () => {
  const sorted = sortVersionsDesc([{ version: '7.4.9' }, { version: '7.10.0' }, { version: '7.4.11' }]);
  assert.deepEqual(sorted.map((v) => v.version), ['7.10.0', '7.4.11', '7.4.9']);
});
