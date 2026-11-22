import assert from 'node:assert/strict';
import test from 'node:test';
import { artifactId, parseBuildMatrix, readBuildMatrix } from '../scripts/engine-matrix.mjs';
import { sourcesFor } from '../scripts/engine-sources.mjs';

const tag = 'engines-candidate-redis-8-6-7--test';

test('candidate tags select version batches while the original 30 packages remain supported', () => {
  assert.equal(readBuildMatrix('engines-candidate-af3fde5').length, 30);
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
