// Library dependency inspection. A fake otool/ldd on PATH exercises the
// parsing branches deterministically, with no real package payload.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import { depsOf } from '../src/libcheck.js';
import { libInspector } from '../src/platform.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'marina-libcheck-'));
const originalPath = process.env.PATH;

after(() => {
  process.env.PATH = originalPath;
  fs.rmSync(root, { recursive: true, force: true });
});

/** Put an executable named after the platform inspector on PATH. */
function fakeInspector(body) {
  const dir = fs.mkdtempSync(path.join(root, 'bin-'));
  const inspector = libInspector();
  const file = path.join(dir, inspector.cmd);
  fs.writeFileSync(file, body);
  fs.chmodSync(file, 0o755);
  process.env.PATH = `${dir}${path.delimiter}${originalPath}`;
  return inspector;
}

test('depsOf skips missing input', () => {
  assert.deepEqual(depsOf(null), { skipped: true, deps: [], missing: [] });
  assert.deepEqual(depsOf(''), { skipped: true, deps: [], missing: [] });
});

test('depsOf skips when the inspector cannot inspect the file', () => {
  assert.deepEqual(depsOf(path.join(root, 'does-not-exist')), { skipped: true, deps: [], missing: [] });
});

test('depsOf parses inspector output and reports unresolvable libraries', { skip: process.platform === 'win32' }, () => {
  const existing = path.join(root, 'libexists.dylib');
  fs.writeFileSync(existing, 'x');
  const inspector = libInspector();

  const output = inspector.cmd === 'otool'
    ? [
        '/fake/binary:',
        '\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0)',
        '\t/System/Library/Frameworks/Security.framework/Security (compatibility version 1.0.0)',
        `\t${existing} (compatibility version 1.0.0)`,
        '\t/old/place/libmissing.dylib (compatibility version 1.0.0)',
        '\trelative/not-absolute.dylib (compatibility version 1.0.0)',
        '',
      ].join('\n')
    : [
        '\tlinux-vdso.so.1 (0x00007fff)',
        '\tlibssl.so.3 => /lib/x86_64-linux-gnu/libssl.so.3 (0x00007f)',
        '\tlibmissing.so => not found',
        '\tnot-a-dependency-line',
        '',
      ].join('\n');

  fakeInspector(`#!/bin/sh\ncat <<'OUT'\n${output}OUT\n`);
  const result = depsOf('/fake/binary');

  assert.equal(result.skipped, false);
  if (inspector.cmd === 'otool') {
    assert.deepEqual(result.deps, [existing, '/old/place/libmissing.dylib']);
    assert.deepEqual(result.missing, ['/old/place/libmissing.dylib']);
  } else {
    assert.deepEqual(result.deps, ['/lib/x86_64-linux-gnu/libssl.so.3']);
    assert.deepEqual(result.missing, ['libmissing.so']);
  }
});

test('depsOf with empty inspector output is skipped, not "all resolved"', { skip: process.platform === 'win32' }, () => {
  fakeInspector('#!/bin/sh\nexit 0\n');
  assert.deepEqual(depsOf('/fake/binary'), { skipped: true, deps: [], missing: [] });
});
