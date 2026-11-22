import assert from 'node:assert/strict';
import test from 'node:test';
import { parseVersions, summarizeHistory } from '../scripts/engine-history.mjs';

test('history inventory uses release metadata and keeps historical patches', () => {
  assert.deepEqual(parseVersions('mysql', '<select name="version"><option value="8.0.2">A</option><option value="8.0.10">B</option></select><option value="1.2.3">OS</option>'), ['8.0.10', '8.0.2']);
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
