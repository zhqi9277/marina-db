// The kernel fragment is the source of truth for what marina's Linux enables.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fragment = fs.readFileSync(path.join(root, 'runtime-os/kernel/marina.fragment'), 'utf8');
const required = fs.readFileSync(path.join(root, 'runtime-os/kernel/required.txt'), 'utf8')
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith('#'));

test('marina kernel fragment enables every required option', () => {
  assert.ok(required.length >= 10);
  for (const name of required) {
    assert.match(fragment, new RegExp(`^CONFIG_${name}=y$`, 'm'), name);
  }
});

test('kernel cmdline boots marina-init from the virtio root disk', () => {
  const cmdline = fs.readFileSync(path.join(root, 'runtime-os/kernel/cmdline'), 'utf8').trim();
  assert.match(cmdline, /root=\/dev\/vda/);
  assert.match(cmdline, /init=\/opt\/marina\/bin\/marina-init/);
  assert.equal(cmdline.includes('pci=off'), false);
});
