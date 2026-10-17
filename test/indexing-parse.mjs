// Offline indexing helpers: listing/href parsing, version parsing and the
// MySQL/MongoDB platform selection rules. No HTTP calls are made.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseHrefs,
  sortVersionsDesc,
  entryOf,
  versionsFromListing,
  mysqlUrlsForVersion,
  mysqlUpstreamCandidates,
  mongoVersionEntries,
  refreshIndex,
  PROFILES,
  SOURCE_ORDER,
} from '../src/indexing.js';
import { PLATFORM, arch } from '../src/platform.js';

test('parseHrefs skips navigation links and cleans query/fragment suffixes', () => {
  const html = `<ul>
    <a href="?C=N;O=D">sort</a>
    <a href="#top">top</a>
    <a href="">empty</a>
    <a>no href</a>
    <a href="mailto:x@example.test">mail</a>
    <a href="javascript:void(0)">js</a>
    <a href="https://example.test/elsewhere">third party</a>
    <a href="https://mirrors.aliyun.com/postgresql/source/v18.1/">mirror</a>
    <a href="/relative/v17.2/">relative</a>
    <a href="v18.2/?query=1#frag">query</a>
    <a href="../">parent</a>
    <a href="./">self</a>
    <a href="/">root</a>
  </ul>`;
  const hrefs = parseHrefs(html);
  assert.deepEqual(hrefs.map((h) => h.name), ['v18.1', 'v17.2', 'v18.2']);
  assert.deepEqual(hrefs.map((h) => h.dir), [true, true, true]);
  assert.equal(hrefs[2].href, 'v18.2/');
  assert.deepEqual(parseHrefs(''), []);
});

test('sortVersionsDesc compares numerically across different lengths', () => {
  assert.deepEqual(
    sortVersionsDesc([{ version: '9.9.9' }, { version: '10.0.0' }, { version: '9.10.0' }]).map((v) => v.version),
    ['10.0.0', '9.10.0', '9.9.9'],
  );
  assert.equal(sortVersionsDesc([{ version: '1.0' }, { version: '1.0.0' }]).length, 2);
});

test('entryOf derives major/kind and merges extras', () => {
  const entry = entryOf('mariadb', '11.4.13', 'aliyun', { urls: ['u'] });
  assert.deepEqual(entry, {
    version: '11.4.13',
    major: '11.4',
    kind: 'source',
    source: 'aliyun',
    urls: ['u'],
  });
  assert.deepEqual(entryOf('redis', '7.4.11', 'huawei').urls, []);
});

test('versionsFromListing dedupes and ignores non-matching names', () => {
  const source = { name: 'upstream', base: 'https://mirror.test/pg/' };
  const hrefs = [
    { name: 'v17.1', dir: true },
    { name: 'v17.1', dir: true },
    { name: 'v17.2', dir: true },
    { name: 'README', dir: false },
  ];
  const versions = versionsFromListing('postgres', PROFILES.postgres, source, hrefs);
  assert.deepEqual(versions.map((v) => v.version), ['17.2', '17.1']);
  assert.equal(versions.length, 2);
  assert.equal(versions[0].source, 'upstream');
  assert.equal(versions[0].urls[0], 'https://mirror.test/pg/v17.2/postgresql-17.2.tar.gz');

  assert.deepEqual(versionsFromListing('postgres', PROFILES.postgres, source, []), []);
});

test('mysqlUrlsForVersion keeps the current platform/arch and ranks SDKs', () => {
  const files = [
    { name: 'mysql-8.0.28-macos15-arm64.tar.gz', url: 'macos15-arm64' },
    { name: 'mysql-8.0.28-macos14-arm64.tar.gz', url: 'macos14-arm64' },
    { name: 'mysql-8.0.28-macos15-x86_64.tar.gz', url: 'macos15-x86_64' },
    { name: 'mysql-8.0.28-linux-glibc2.28-aarch64.tar.xz', url: 'glibc2.28-aarch64' },
    { name: 'mysql-8.0.28-linux-glibc2.17-aarch64.tar.xz', url: 'glibc2.17-aarch64' },
    { name: 'mysql-8.0.28-linux-glibc2.28-x86_64.tar.xz', url: 'glibc2.28-x86_64' },
    { name: 'mysql-8.0.28-winx64.zip', url: 'winx64' },
    { name: 'mysql-8.0.28-macos15-arm64.tar.xz', url: 'wrong-extension' },
  ];
  const urls = mysqlUrlsForVersion(files, '8.0.28');

  if (PLATFORM === 'darwin' && arch('darwin') === 'arm64') assert.deepEqual(urls, ['macos15-arm64', 'macos14-arm64']);
  else if (PLATFORM === 'darwin') assert.deepEqual(urls, ['macos15-x86_64']);
  else if (PLATFORM === 'linux' && arch('linux') === 'aarch64') assert.deepEqual(urls, ['glibc2.28-aarch64', 'glibc2.17-aarch64']);
  else if (PLATFORM === 'linux') assert.deepEqual(urls, ['glibc2.28-x86_64']);
  else assert.deepEqual(urls, ['winx64']);
});

test('mysqlUpstreamCandidates builds platform-specific fallbacks', () => {
  const urls = mysqlUpstreamCandidates('8.0.28');
  assert.ok(urls.length > 0);
  for (const url of urls) {
    assert.ok(url.startsWith('https://cdn.mysql.com/Downloads/MySQL-8.0/'), url);
    assert.ok(url.includes('mysql-8.0.28-'), url);
  }
  if (PLATFORM === 'darwin') {
    assert.equal(urls.length, 3);
    for (const url of urls) assert.match(url, new RegExp(`macos1[345]-${arch('darwin')}\\.tar\\.gz$`));
  } else if (PLATFORM === 'linux') {
    assert.equal(urls.length, 2);
    for (const url of urls) assert.match(url, new RegExp(`glibc2\\.(28|17)-${arch('linux')}\\.tar\\.xz$`));
  } else {
    assert.equal(urls.length, 1);
    assert.match(urls[0], /winx64\.zip$/);
  }
});

test('mongoVersionEntries drops unstable/non-semver and keeps the native artifact', () => {
  const native = PLATFORM === 'darwin'
    ? { target: 'macos', arch: arch('darwin') }
    : PLATFORM === 'linux'
      ? { target: 'ubuntu2204', arch: arch('linux') }
      : { target: 'windows', arch: 'x86_64' };
  const dl = (target, a, url, sha256) => ({ edition: 'base', target, arch: a, archive: { url, sha256 } });

  const downloads = [
    dl(native.target, native.arch, 'native-url', 'a'.repeat(64)),
    { edition: 'enterprise', target: native.target, arch: native.arch, archive: { url: 'enterprise-url' } },
    dl('freebsd', native.arch, 'wrong-target-url'),
  ];
  if (PLATFORM === 'linux') downloads.push(dl('rhel90', arch('linux'), 'rhel-url'));

  const json = {
    versions: [
      { version: '7.0.1', downloads },
      { version: '7.0.2', development_release: true, downloads: [dl(native.target, native.arch, 'dev-url')] },
      { version: '7.0.3-rc0', downloads: [dl(native.target, native.arch, 'rc-url')] },
      { version: '7.0', downloads: [dl(native.target, native.arch, 'short-url')] },
      { version: '7.0.4', downloads: [dl(native.target, native.arch, 'no-sha')] },
      { version: '7.0.5', downloads: [dl('freebsd', 'x86_64', 'elsewhere')] },
      { version: '7.0.6' },
    ],
  };

  const entries = mongoVersionEntries(json);
  assert.deepEqual(entries.map((e) => e.version), ['7.0.4', '7.0.1']);
  const byVersion = new Map(entries.map((e) => [e.version, e]));
  assert.deepEqual(byVersion.get('7.0.1').urls, ['native-url']);
  assert.equal(byVersion.get('7.0.1').sha256, 'a'.repeat(64));
  assert.equal(byVersion.get('7.0.1').kind, 'binary');
  assert.equal(byVersion.get('7.0.1').major, '7.0');
  assert.equal(byVersion.get('7.0.1').source, 'upstream');
  assert.equal(byVersion.get('7.0.4').sha256, null);
  assert.deepEqual(mongoVersionEntries({ versions: [] }), []);
  assert.deepEqual(mongoVersionEntries({}), []);
});

test('SOURCE_ORDER stays in sync with every index profile', () => {
  assert.deepEqual(
    Object.keys(SOURCE_ORDER).sort(),
    ['mariadb', 'memcached', 'mongodb', 'mysql', 'postgres', 'redis'],
  );
  for (const [key, profile] of Object.entries(PROFILES)) {
    assert.deepEqual(SOURCE_ORDER[key], profile.sources.map((s) => s.name), `source order drifted for ${key}`);
  }
});

test('refreshIndex rejects an engine without a profile', async () => {
  await assert.rejects(refreshIndex('oracle'), /no index profile for "oracle"/);
});
