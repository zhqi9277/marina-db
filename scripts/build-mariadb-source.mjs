#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(process.argv[2] || '.');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'marina-mariadb-'));
let cmake = 'cmake';

function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', ...options });
  if (result.status !== 0) process.exit(result.status || 1);
}

if (process.platform === 'darwin') {
  const which = spawnSync('which', ['cmake'], { encoding: 'utf8' });
  if (which.status !== 0) {
    const archive = path.join(work, 'cmake.tar.gz');
    run('curl', ['-fsSL', '--retry', '3', '-o', archive,
      'https://github.com/Kitware/CMake/releases/download/v3.31.6/cmake-3.31.6-macos-universal.tar.gz']);
    fs.mkdirSync(path.join(work, 'cmake'), { recursive: true });
    run('tar', ['-xzf', archive, '-C', path.join(work, 'cmake'), '--strip-components=1']);
    cmake = path.join(work, 'cmake', 'CMake.app', 'Contents', 'bin', 'cmake');
    if (!fs.existsSync(cmake)) cmake = path.join(work, 'cmake', 'bin', 'cmake');
  }
}

fs.rmSync(path.join(root, '.marina-build'), { recursive: true, force: true });
run(cmake, [
  '-S', root,
  '-B', path.join(root, '.marina-build'),
  `-DCMAKE_INSTALL_PREFIX=${root}`,
  '-DCMAKE_BUILD_TYPE=Release',
  '-DWITH_UNIT_TESTS=OFF',
  '-DWITHOUT_TOKUDB=ON',
  '-DPLUGIN_COLUMNSTORE=NO',
  '-DPLUGIN_S3=NO',
  '-DPLUGIN_MROONGA=NO',
  '-DWITHOUT_MROONGA=ON',
  '-DPLUGIN_ROCKSDB=NO',
  '-DWITHOUT_ROCKSDB=ON',
  '-DWITH_SSL=bundled',
  '-DWITH_PCRE=bundled',
]);
run(cmake, ['--build', path.join(root, '.marina-build'), '--parallel', String(process.env.MARINA_BUILD_JOBS || 6)]);
run(cmake, ['--install', path.join(root, '.marina-build')]);
