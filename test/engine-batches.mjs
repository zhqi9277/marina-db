import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { artifactId, parseBuildMatrix, readBuildMatrix, selectEnginePlan } from '../scripts/engine-matrix.mjs';
import { sourcesFor } from '../scripts/engine-sources.mjs';
import { catalogArtifact, mergeCatalog } from '../scripts/make-manifest.mjs';

const tag = 'engines-candidate-redis-8-6-7--test';

test('candidate tags select version batches while the original 30 packages remain supported', () => {
  const baseline = readBuildMatrix('engines-candidate-af3fde5');
  assert.equal(baseline.filter(({ engine }) => !['qdrant', 'milvus'].includes(engine)).length, 30);
  assert.equal(baseline.filter(({ engine }) => engine === 'qdrant').length, 5);
  assert.equal(baseline.filter(({ engine }) => engine === 'milvus').length, 4);
  assert.throws(() => selectEnginePlan('milvus', { platforms: 'win32-x64' }), /no locked targets selected/);
  const matrix = readBuildMatrix(tag);
  assert.equal(matrix.length, 5);
  assert.ok(matrix.every((row) => row.engine === 'redis' && row.version === '8.6.7'));
  for (const row of matrix) {
    const { binary, source } = sourcesFor(row);
    assert.match((binary || source).sha256, /^[a-f0-9]{64}$/);
    assert.equal(Boolean(binary), row.os === 'win32');
  }
});

test('a batch can hold multiple patches on the same target with distinct asset names', () => {
  const sample = { engine: 'redis', version: '8.6.7', os: 'darwin', arch: 'arm64' };
  const matrix = parseBuildMatrix([sample, { ...sample, version: '8.6.6' }]);
  assert.equal(new Set(matrix.map(artifactId)).size, 2);
  assert.throws(() => parseBuildMatrix([sample, sample]), /duplicate engine batch target/);
  assert.throws(() => parseBuildMatrix([{ ...sample, os: 'win32' }]), /invalid engine batch target/);
});

test('custom build inputs are locked and platform appropriate', () => {
  const binary = { url: 'https://example.test/archive.zip', sha256: '1'.repeat(64) };
  const row = { os: 'win32', inputs: { binary } };
  assert.equal(sourcesFor(row).binary, binary);
  assert.throws(() => sourcesFor({ ...row, inputs: { binary: { ...binary, sha256: null } } }), /require an HTTPS URL and SHA-256/);
  assert.throws(() => sourcesFor({ ...row, inputs: { source: binary } }), /invalid custom build inputs/);
});

test('one dispatch selects multiple checked-in versions of one engine', () => {
  const plan = selectEnginePlan('redis', { versions: '7.4.11, 8.6.7', platforms: 'linux-x64' });
  assert.deepEqual(plan.map(artifactId), ['redis-7.4.11-linux-x64', 'redis-8.6.7-linux-x64']);
  assert.throws(() => selectEnginePlan('redis', { versions: '7.4.11, 0.1.0' }), /no locked targets selected for 0.1.0/);
});

test('history dispatch includes all prepared versions when versions are omitted', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marina-engine-history-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const version of ['8.6.6', '8.6.7']) {
    const plan = readBuildMatrix(tag).map((row) => ({ ...row, version }));
    fs.writeFileSync(path.join(dir, 'redis-' + version.replaceAll('.', '-') + '.json'), JSON.stringify(plan));
  }
  fs.writeFileSync(path.join(dir, 'redis-results.jsonl'), '{}\n');
  const plan = selectEnginePlan('redis', { historyDir: dir, platforms: 'win32-x64' });
  assert.deepEqual(plan.map(artifactId), ['redis-8.6.6-windows-x64', 'redis-8.6.7-windows-x64']);
  assert.throws(() => selectEnginePlan('redis', { historyDir: dir, platforms: 'win32-arm64' }), /no locked targets selected/);
});

test('migration changes catalog URLs while preserving published bytes', () => {
  const row = readBuildMatrix(tag)[0];
  const archive = { fileName: artifactId(row) + '.tar.gz', size: 123, sha256: '1'.repeat(64) };
  const old = catalogArtifact(row, archive, 'https://example.test/engines-candidate-redis/' + archive.fileName);
  const migrated = { ...old, url: 'https://example.test/engines-redis/' + archive.fileName };
  const previous = { schema: 1, artifacts: [old] };
  assert.deepEqual(mergeCatalog(previous, { schema: 1, artifacts: [migrated] }).artifacts, [migrated]);
  assert.throws(() => mergeCatalog(previous, { artifacts: [{ ...migrated, sha256: '2'.repeat(64) }] }), /cannot be replaced/);
});
