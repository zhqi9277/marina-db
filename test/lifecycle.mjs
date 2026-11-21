// Path-free configs do not make stale absolute config text block startup.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { start } from '../src/runtime/lifecycle.js';

test('start() ignores stale absolute config text and checks the payload', async () => {
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
  await assert.rejects(start(ctx, { quiet: true }), /payload|cannot find|server binary/i);
  assert.ok(Date.now() - t0 < 2000, 'must fail fast, not wait for the 30s readiness window');
});
