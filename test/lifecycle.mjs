// A moved project must fail fast (not after a 30s timeout) with an actionable hint.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { start } from '../src/lifecycle.js';

test('start() refuses a stale config immediately', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marina-life-'));
  const confFile = path.join(dir, 'my.cnf');
  fs.writeFileSync(confFile, `[mysqld]\nbasedir = /old/place/runtime/engines/mysql/8.4/8.4.11\n`);

  const ctx = {
    key: 'mysql',
    major: '8.4',
    version: '8.4.11',
    port: 1,
    root: dir,
    confFile,
    dataDir: path.join(dir, 'data'),
    sockFile: path.join(dir, 'x.sock'),
    pidFile: path.join(dir, 'x.pid'),
    logDir: dir,
    logFile: path.join(dir, 'x.log'),
    engine: { key: 'mysql', label: 'MySQL' },
  };

  const t0 = Date.now();
  await assert.rejects(start(ctx, { quiet: true }), /different marina root/);
  assert.ok(Date.now() - t0 < 2000, 'must fail fast, not wait for the 30s readiness window');
});
