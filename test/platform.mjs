// Platform abstraction: env conventions, arch tokens, SDK tags, tar flags,
// library inspector selection and directory/file linking.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import {
  IS_MAC, IS_LINUX, IS_WIN, OS_LABEL, PLATFORM,
  env, arch, exe, macosSdkTags, tarArgs, libInspector, linkDir, linkFile,
} from '../src/platform.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'marina-platform-'));

after(() => fs.rmSync(root, { recursive: true, force: true }));

test('platform constants agree with process.platform', () => {
  assert.equal(PLATFORM, process.platform);
  assert.equal(IS_MAC, process.platform === 'darwin');
  assert.equal(IS_LINUX, process.platform === 'linux');
  assert.equal(IS_WIN, process.platform === 'win32');
  assert.equal([IS_MAC, IS_LINUX, IS_WIN].filter(Boolean).length, 1);
  assert.equal(OS_LABEL, IS_MAC ? 'macOS' : IS_LINUX ? 'Linux' : 'Windows');
});

test('env reads MARINA_<name> and treats an empty value as defined', () => {
  const saved = { MARINA_UNIT_TEST: process.env.MARINA_UNIT_TEST, MARINA_UNIT_EMPTY: process.env.MARINA_UNIT_EMPTY };
  try {
    process.env.MARINA_UNIT_TEST = 'value';
    process.env.MARINA_UNIT_EMPTY = '';
    assert.equal(env('UNIT_TEST'), 'value');
    assert.equal(env('UNIT_TEST', 'fallback'), 'value');
    assert.equal(env('UNIT_EMPTY', 'fallback'), '');
    assert.equal(env('UNIT_MISSING', 'fallback'), 'fallback');
    assert.equal(env('UNIT_MISSING'), undefined);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('arch maps node archs to package-name tokens per platform', () => {
  const expected = {
    arm64: { darwin: 'arm64', linux: 'aarch64', win32: 'arm64' },
    x64: { darwin: 'x86_64', linux: 'x86_64', win32: 'x64' },
  }[process.arch];
  if (expected) {
    for (const platform of ['darwin', 'linux', 'win32']) {
      assert.equal(arch(platform), expected[platform], `${platform}/${process.arch}`);
    }
  }
  // unknown platforms fall back to the macOS mapping
  assert.equal(arch('not-a-platform'), arch('darwin'));
});

test('exe appends .exe only on Windows', () => {
  assert.equal(exe('mysqld'), IS_WIN ? 'mysqld.exe' : 'mysqld');
});

test('macosSdkTags clamps OS_RELEASE to the supported 13..15 range', () => {
  const saved = process.env.MARINA_OS_RELEASE;
  try {
    delete process.env.MARINA_OS_RELEASE;
    assert.deepEqual(macosSdkTags(), [15, 14, 13]);

    process.env.MARINA_OS_RELEASE = '14.2';
    assert.deepEqual(macosSdkTags(), [14, 13]);

    process.env.MARINA_OS_RELEASE = '13.5.1';
    assert.deepEqual(macosSdkTags(), [13]);

    process.env.MARINA_OS_RELEASE = '12.0';
    assert.deepEqual(macosSdkTags(), [13]);

    process.env.MARINA_OS_RELEASE = '99';
    assert.deepEqual(macosSdkTags(), [15, 14, 13]);

    process.env.MARINA_OS_RELEASE = 'garbage';
    assert.deepEqual(macosSdkTags(), [15, 14, 13]);
  } finally {
    if (saved === undefined) delete process.env.MARINA_OS_RELEASE;
    else process.env.MARINA_OS_RELEASE = saved;
  }
});

test('tarArgs picks the extraction flag from the archive suffix', () => {
  assert.deepEqual(tarArgs('postgresql-17.11.tar.gz'), ['-xzf']);
  assert.deepEqual(tarArgs('redis.tgz'), ['-xzf']);
  assert.deepEqual(tarArgs('mysql-8.0.28.tar.xz'), ['-xJf']);
  assert.deepEqual(tarArgs('legacy.tar.bz2'), ['-xjf']);
  assert.deepEqual(tarArgs('mysql-8.0.28-winx64.zip'), ['-xf']);
  assert.deepEqual(tarArgs('payload.unknown'), ['-xf']);
});

test('libInspector selects otool, ldd, or nothing', () => {
  const inspector = libInspector();
  if (IS_MAC) assert.deepEqual(inspector, { cmd: 'otool', args: ['-L'] });
  else if (IS_LINUX) assert.deepEqual(inspector, { cmd: 'ldd', args: [] });
  else assert.equal(inspector, null);
});

test('linkDir links a directory and can be re-run', () => {
  const target = path.join(root, 'target');
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'f.txt'), 'hello');

  const link = path.join(root, 'dir-link');
  const mode = linkDir(target, link);
  assert.ok(mode === 'symlink' || mode === 'copy');
  assert.equal(fs.readFileSync(path.join(link, 'f.txt'), 'utf8'), 'hello');
  if (!IS_WIN) {
    assert.equal(mode, 'symlink');
    assert.equal(fs.realpathSync(link), fs.realpathSync(target));
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  }

  // second call replaces the existing link instead of nesting inside it
  assert.equal(linkDir(target, link), mode);
  assert.equal(fs.readFileSync(path.join(link, 'f.txt'), 'utf8'), 'hello');
});

test('linkFile links a file and copies when the OS refuses', () => {
  const target = path.join(root, 'source.txt');
  fs.writeFileSync(target, 'content');
  const link = path.join(root, 'file-link');

  const mode = linkFile(target, link);
  assert.ok(mode === 'symlink' || mode === 'copy');
  assert.equal(fs.readFileSync(link, 'utf8'), 'content');
  if (!IS_WIN) assert.equal(mode, 'symlink');

  // idempotent: replacing the link keeps the same content
  assert.equal(linkFile(target, link), mode);
  assert.equal(fs.readFileSync(link, 'utf8'), 'content');
});
