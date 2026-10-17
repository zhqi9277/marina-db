// Stale generated-config detection (project directory moved).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { staleConfigReferences } from '../src/configcheck.js';
import { HOME } from '../src/paths.js';

function conf(text) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'marina-conf-')), 'my.cnf');
  fs.writeFileSync(file, text);
  return file;
}

test('config pointing at the current marina home is fresh', () => {
  const file = conf(`[mysqld]\nbasedir = ${HOME}/runtime/engines/mysql/8.4/8.4.11\ndatadir = ${HOME}/runtime/data/mysql/8.4\n`);
  assert.deepEqual(staleConfigReferences({ confFile: file }), []);
});

test('config pointing at another marina root is stale', () => {
  const file = conf(`[mysqld]\nbasedir = /old/place/runtime/engines/mysql/8.4/8.4.11\n`);
  assert.deepEqual(staleConfigReferences({ confFile: file }), ['/old/place/runtime/engines/mysql/8.4/8.4.11']);
});

test('comments and non-marina paths are ignored', () => {
  const file = conf(`# basedir = /old/place/runtime/engines/x\nlog-error = /var/log/mysql.log\n`);
  assert.deepEqual(staleConfigReferences({ confFile: file }), []);
});

test('missing config is treated as fresh', () => {
  assert.deepEqual(staleConfigReferences({ confFile: '/nonexistent/my.cnf' }), []);
  assert.deepEqual(staleConfigReferences({}), []);
});
