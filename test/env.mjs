// Spawned processes must not inherit another tool's environment.
import assert from 'node:assert/strict';
import test from 'node:test';

import { buildEnv, clientEnv, SYSTEM_PATH } from '../src/core/env.js';
import { spawnAsync } from '../src/install/archive.js';
import { IS_WIN } from '../src/core/platform.js';

const shell = {
  HOME: '/home/dev',
  PATH: '/opt/other-stack/bin:/usr/bin',
  PGHOST: '/opt/other-stack/tmp',
  PGPASSWORD: 'secret',
  MYSQL_PWD: 'secret',
  MYSQL_TCP_PORT: '3399',
  REDISCLI_AUTH: 'secret',
  PKG_CONFIG: '/opt/other-stack/bin/pkg-config',
  CPPFLAGS: '-I/opt/other-stack/include',
  LDFLAGS: '-L/opt/other-stack/lib',
  CC: '/opt/other-stack/bin/cc',
  MAKEFLAGS: '-I/opt/other-stack/include',
  DYLD_LIBRARY_PATH: '/opt/other-stack/lib',
};

test('clientEnv drops server-selecting variables and keeps the rest', () => {
  const env = clientEnv(shell);
  for (const name of ['PGHOST', 'PGPASSWORD', 'MYSQL_PWD', 'MYSQL_TCP_PORT', 'REDISCLI_AUTH', 'DYLD_LIBRARY_PATH']) {
    assert.equal(name in env, false, name);
  }
  assert.equal(env.HOME, '/home/dev');
  assert.equal(env.PATH, shell.PATH);
  assert.equal(shell.PGHOST, '/opt/other-stack/tmp', 'the input is not mutated');
});

test('buildEnv drops compiler/linker overrides and narrows PATH to the system toolchain', { skip: IS_WIN }, () => {
  const env = buildEnv(shell);
  for (const name of ['PKG_CONFIG', 'CPPFLAGS', 'LDFLAGS', 'CC', 'MAKEFLAGS', 'DYLD_LIBRARY_PATH', 'PGHOST']) {
    assert.equal(name in env, false, name);
  }
  assert.equal(env.PATH, SYSTEM_PATH.join(':'));
  assert.equal(env.HOME, '/home/dev');
});

test('MARINA_BUILD_PATH adds explicit tool directories ahead of the system ones', { skip: IS_WIN }, () => {
  const env = buildEnv({ ...shell, MARINA_BUILD_PATH: '/opt/cmake/bin:/opt/more/bin' });
  assert.equal(env.PATH, ['/opt/cmake/bin', '/opt/more/bin', ...SYSTEM_PATH].join(':'));
});

test('spawnAsync does not hand connection variables to the child', { skip: IS_WIN }, async () => {
  process.env.PGHOST = '/opt/other-stack/tmp';
  try {
    const res = await spawnAsync(process.execPath, ['-p', 'String(process.env.PGHOST)']);
    assert.equal(res.stdout.trim(), 'undefined');
  } finally {
    delete process.env.PGHOST;
  }
});
