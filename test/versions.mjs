// Offline tests for version selection and platform decoration.
import assert from 'node:assert/strict';
import test from 'node:test';
import { pickEntry } from '../src/install/versions.js';
import { majorOf } from '../src/install/catalog.js';
import { normalizeOs } from '../src/install/overlay.js';

const list = [
  { version: '8.4.11', major: '8.4', kind: 'binary', supported: true, urls: ['u1'] },
  { version: '8.0.29', major: '8.0', kind: 'binary', supported: true, urls: ['u2'] },
  { version: '8.0.28', major: '8.0', kind: 'binary', supported: true, urls: ['u3'] },
];

test('major directory depth is driven by engine metadata', () => {
  assert.equal(majorOf('mysql', '8.4.11'), '8.4');
  assert.equal(majorOf('mongodb', '7.0.45'), '7.0');
  assert.equal(majorOf('postgres', '17.11'), '17');
  assert.equal(majorOf('redis', '7.4.11'), '7');
  assert.equal(majorOf('memcached', '1.6.45'), '1');
  assert.equal(majorOf('mariadb', '11.4.13'), '11.4');
});

test('pickEntry: latest, major line, exact version', () => {
  assert.equal(pickEntry('mysql', list, null).version, '8.4.11');
  assert.equal(pickEntry('mysql', list, '8.0').version, '8.0.29');
  assert.equal(pickEntry('mysql', list, '8.0.28').version, '8.0.28');
  assert.equal(pickEntry('mysql', list, '5.7'), null);
});

test('overlay os tokens are normalized (windows -> win32)', () => {
  assert.equal(normalizeOs('windows'), 'win32');
  assert.equal(normalizeOs('win32'), 'win32');
  assert.equal(normalizeOs('macOS'), 'darwin');
  assert.equal(normalizeOs('osx'), 'darwin');
  assert.equal(normalizeOs('linux'), 'linux');
});
