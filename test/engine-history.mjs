import assert from 'node:assert/strict';
import test from 'node:test';
import { parseVersions, summarizeHistory } from '../scripts/engine-history.mjs';
import { incrementalCandidates } from '../scripts/prepare-engine-increment.mjs';

test('history inventory uses release metadata and keeps historical patches', () => {
  assert.deepEqual(parseVersions('mysql', '<select name="version"><option value="8.0.2">A</option><option value="8.0.11">B</option><option value="8.0.12">C</option></select><option value="1.2.3">OS</option>'), ['8.0.12', '8.0.11']);
  assert.deepEqual(parseVersions('mysql', 'sha\trefs/tags/mysql-8.4.12\nsha\trefs/tags/mysql-8.4.13-rc\nsha\trefs/tags/mysql-8.0.2\n'), ['8.4.12']);
  assert.deepEqual(parseVersions('mariadb', '<tr><td><a>11.4.0</a></td><td>date</td><td>Alpha</td></tr><tr><td><a>11.4.13</a></td><td>date</td><td>Stable</td></tr>'), ['11.4.13']);
  assert.deepEqual(parseVersions('postgres', '<a href="v1.09/">old</a><a href="v17.8/">stable</a><a href="v18beta1/">beta</a>'), ['17.8', '1.09']);
  assert.deepEqual(parseVersions('redis', '<a href="redis-1.02.tar.gz">old</a><a href="redis-8.0.0-rc1.tar.gz">RC</a>'), ['1.02']);
  assert.deepEqual(parseVersions('memcached', 'sha\trefs/tags/1.6.4\nsha\trefs/tags/1.6.12\nsha\trefs/tags/1.7.0-rc1\n'), ['1.6.12', '1.6.4']);
  assert.deepEqual(parseVersions('mongodb', JSON.stringify({ versions: [
    { version: '7.0.45', production_release: true },
    { version: '7.0.1', production_release: true, release_candidate: true },
    { version: '7.1.0', development_release: true },
  ] })), ['7.0.45']);
});

test('incremental planning queues new patches and fills missing platforms without rebuilding history', () => {
  const artifact = (version, os, arch) => ({
    name: 'redis', version, os, arch,
    size: 10, sha256: 'f'.repeat(64), url: 'https://example.test/redis.tar.gz',
  });
  const published = { artifacts: [artifact('7.4.11', 'linux', 'x64'), artifact('8.6.8', 'win32', 'x64')] };
  const upstream = ['5.0.0', '6.2.23', '7.4.10', '7.4.11', '7.4.12', '8.4.9', '8.6.8', '8.6.9', '8.6.10', '8.8.0'];
  const snapshot = ['6.2.24', '7.4.11', '8.4.9', '8.6.8'];
  const planned = incrementalCandidates('redis', upstream, published, snapshot);
  assert.deepEqual(planned.map((row) => row.version), ['8.8.0', '8.6.10', '8.6.9', '8.6.8', '7.4.12', '7.4.11']);
  assert.ok(!planned.find((row) => row.version === '7.4.11').pendingTargets.includes('linux-x64'));
  assert.ok(!planned.find((row) => row.version === '8.6.8').pendingTargets.includes('win32-x64'));
});

test('incremental planning treats PostgreSQL patch versions as one major series', () => {
  const platforms = [['linux', 'x64'], ['linux', 'arm64'], ['darwin', 'x64'], ['darwin', 'arm64'], ['win32', 'x64']];
  const published = { artifacts: platforms.map(([os, arch]) => ({
    name: 'postgresql', version: '17.11', os, arch,
    size: 10, sha256: 'f'.repeat(64), url: 'https://example.test/postgres.tar.gz',
  })) };
  const planned = incrementalCandidates('postgres', ['17.10', '17.11', '17.12', '18.4'], published, ['17.11', '18.4']);
  assert.deepEqual(planned.map((row) => row.version), ['18.4', '17.12']);
  assert.deepEqual(incrementalCandidates('postgres', ['17.10', '17.11'], published, ['17.11']), []);
});

test('history distinguishes published platform builds from upstream availability', () => {
  const published = { artifacts: [{
    name: 'postgresql', version: '17.11', os: 'darwin', arch: 'aarch64',
    size: 10, sha256: 'f'.repeat(64), url: 'https://example.test/17.11.tar.gz',
  }] };
  const { postgres } = summarizeHistory({ postgres: ['17.11', '17.1'] }, published);
  assert.deepEqual(postgres.versions[0].publishedTargets, ['darwin-arm64']);
  assert.equal(postgres.versions[0].pendingTargets.length, 4);
  assert.deepEqual(postgres.versions[1].publishedTargets, []);
  assert.equal(postgres.versions[1].pendingTargets.length, 5);
});
