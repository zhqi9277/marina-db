// Stale generated-config detection against an isolated MARINA_HOME, including
// the "runtime" path-segment boundary and unreadable config files.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'marina-configcheck-'));
process.env.MARINA_HOME = HOME;

const { staleConfigReferences } = await import('../src/configcheck.js');

after(() => fs.rmSync(HOME, { recursive: true, force: true }));

let counter = 0;
function conf(text) {
  const dir = fs.mkdtempSync(path.join(HOME, 'conf-'));
  const file = path.join(dir, `db-${counter++}.conf`);
  fs.writeFileSync(file, text);
  return file;
}

test('paths under the current MARINA_HOME are considered fresh', () => {
  const file = conf([
    '[mysqld]',
    `basedir = ${HOME}/runtime/engines/mysql/8.4/8.4.11`,
    `datadir = ${HOME}/runtime/data/mysql/8.4`,
    '',
  ].join('\n'));
  assert.deepEqual(staleConfigReferences({ confFile: file }), []);
});

test('each runtime path outside MARINA_HOME is reported, in file order', () => {
  const file = conf([
    '[mysqld]',
    'basedir = /old/place/runtime/engines/mysql/8.4/8.4.11',
    'datadir = /srv/other/runtime/data/mysql/8.4',
  ].join('\n'));
  assert.deepEqual(staleConfigReferences({ confFile: file }), [
    '/old/place/runtime/engines/mysql/8.4/8.4.11',
    '/srv/other/runtime/data/mysql/8.4',
  ]);
});

test('only a real "runtime/" path segment is suspicious', () => {
  const file = conf([
    '# basedir = /commented/out/runtime/engines/x',
    '[mysqld]',
    'basedir = /old/myruntime/engines/x',
    'datadir = /old/runtimeish/data',
    'tmpdir = /old/runtime',
    'log-error = /var/log/mysql.err',
    'server-id = 42',
    'socket = relative/runtime/sock',
    'datadir = /old/runtime/data # moved root',
  ].join('\n'));
  assert.deepEqual(staleConfigReferences({ confFile: file }), ['/old/runtime/data']);
});

test('missing, unreadable and empty inputs are treated as fresh', () => {
  assert.deepEqual(staleConfigReferences({ confFile: path.join(HOME, 'nope.conf') }), []);
  assert.deepEqual(staleConfigReferences({ confFile: HOME }), []); // a directory, not a file
  assert.deepEqual(staleConfigReferences({ confFile: conf('') }), []);
  assert.deepEqual(staleConfigReferences({}), []);
  assert.deepEqual(staleConfigReferences(null), []);
  assert.deepEqual(staleConfigReferences(undefined), []);
});
