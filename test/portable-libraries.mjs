import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { relocate, verifyLibraries } from '../scripts/portable-libraries.mjs';

test('macOS packages resolve copied libraries after the original toolchain is removed', { skip: process.platform !== 'darwin' }, async (t) => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'marina relocatable '));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const build = path.join(work, 'toolchain');
  const root = path.join(work, 'payload');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(build);
  fs.mkdirSync(bin, { recursive: true });

  const base = path.join(build, 'libbase.dylib');
  const runtime = path.join(build, 'libruntime.dylib');
  const program = path.join(bin, 'program');
  function compile(name, source, ...args) {
    const file = path.join(work, name + '.c');
    fs.writeFileSync(file, source);
    execFileSync('cc', [file, '-Wl,-headerpad_max_install_names', ...args]);
  }
  compile('base', 'int base(void) { return 42; }', '-dynamiclib', '-install_name', '@rpath/libbase.dylib', '-o', base);
  compile('runtime', 'int base(void); int value(void) { return base(); }',
    '-dynamiclib', base, '-install_name', runtime, '-Wl,-rpath,' + build, '-o', runtime);
  compile('main', 'int value(void); int main(void) { return value() != 42; }', runtime, '-o', program);

  await relocate(root, { darwinLibraries: [runtime, base] });
  fs.rmSync(build, { recursive: true });
  const moved = path.join(work, 'installed elsewhere');
  fs.renameSync(root, moved);
  verifyLibraries(moved);
  execFileSync(path.join(moved, 'bin', 'program'));
});
