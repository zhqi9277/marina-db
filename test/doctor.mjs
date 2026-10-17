// Local self-check contract (no network).
import assert from 'node:assert/strict';
import test from 'node:test';
import { runDoctor } from '../src/doctor.js';

test('doctor returns named checks with boolean verdicts', async () => {
  const checks = await runDoctor();
  assert.ok(Array.isArray(checks));
  assert.ok(checks.length >= 6);

  const names = checks.map((c) => c.name);
  for (const required of ['platform', 'node', 'tar', 'MARINA_HOME', 'index', 'libs', 'ports']) {
    assert.ok(names.includes(required), `missing check: ${required}`);
  }
  for (const c of checks) {
    assert.equal(typeof c.name, 'string');
    assert.equal(typeof c.value, 'string');
    assert.equal(typeof c.ok, 'boolean');
  }
});
