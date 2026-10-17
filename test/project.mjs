// Project pins: .marinarc discovery walks up from a start directory.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import { PROJECT_FILE, findProjectFile, readProject } from '../src/project.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'marina-project-'));
const deep = path.join(root, 'a', 'b', 'c');
fs.mkdirSync(deep, { recursive: true });
const topPin = path.join(root, 'a', '.marinarc');
fs.writeFileSync(topPin, JSON.stringify({ mysql: '8.4.11', redis: '7.4.11' }));

after(() => fs.rmSync(root, { recursive: true, force: true }));

test('PROJECT_FILE is the documented dot-file', () => {
  assert.equal(PROJECT_FILE, '.marinarc');
});

test('findProjectFile walks up to the nearest .marinarc', () => {
  assert.equal(findProjectFile(deep), topPin);
  assert.equal(findProjectFile(path.join(root, 'a', 'b')), topPin);

  const nested = path.join(root, 'a', 'b', '.marinarc');
  fs.writeFileSync(nested, JSON.stringify({ mariadb: '11.4.13' }));
  assert.equal(findProjectFile(deep), nested);
  assert.equal(findProjectFile(path.join(root, 'a')), topPin);
});

test('findProjectFile returns null when no ancestor pins the project', () => {
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'marina-nopin-'));
  try {
    const inner = path.join(bare, 'x', 'y');
    fs.mkdirSync(inner, { recursive: true });
    assert.equal(findProjectFile(inner), null);
  } finally {
    fs.rmSync(bare, { recursive: true, force: true });
  }
});

test('readProject returns the file and parsed pins', () => {
  assert.deepEqual(readProject(topPin), {
    file: topPin,
    pins: { mysql: '8.4.11', redis: '7.4.11' },
  });
  // defaults come from the current directory
  const cwd = process.cwd();
  try {
    process.chdir(deep);
    assert.equal(fs.realpathSync(findProjectFile()), fs.realpathSync(path.join(root, 'a', 'b', '.marinarc')));
    assert.deepEqual(readProject().pins, { mariadb: '11.4.13' });
  } finally {
    process.chdir(cwd);
  }
  assert.equal(readProject(null), null);
  assert.equal(readProject(''), null);
});

test('readProject prefixes parse/read errors with the file path', () => {
  const bad = path.join(root, 'bad.marinarc');
  fs.writeFileSync(bad, '{ definitely not json');
  assert.throws(() => readProject(bad), (e) => {
    assert.ok(e.message.startsWith(`${bad}: `), e.message);
    assert.match(e.message, /JSON/);
    return true;
  });

  const missing = path.join(root, 'missing.marinarc');
  assert.throws(() => readProject(missing), (e) => {
    assert.ok(e.message.startsWith(`${missing}: `), e.message);
    assert.match(e.message, /ENOENT/);
    return true;
  });
});
