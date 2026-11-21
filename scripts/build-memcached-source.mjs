#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(process.argv[2] || '.');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'marina-memcached-'));

function run(cmd, args, cwd) {
  const result = spawnSync(cmd, args, { cwd, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}

const libeventArchive = path.join(work, 'libevent.tar.gz');
run('curl', ['-fsSL', '--retry', '3', '-o', libeventArchive,
  'https://github.com/libevent/libevent/releases/download/release-2.1.12-stable/libevent-2.1.12-stable.tar.gz'], root);
const libeventSrc = path.join(work, 'libevent');
fs.mkdirSync(libeventSrc, { recursive: true });
run('tar', ['-xzf', libeventArchive, '-C', libeventSrc, '--strip-components=1'], root);
const libeventPrefix = path.join(work, 'libevent-prefix');
run('./configure', ['--prefix=' + libeventPrefix, '--disable-openssl', '--disable-shared'], libeventSrc);
run('make', ['-j' + String(process.env.MARINA_BUILD_JOBS || 6)], libeventSrc);
run('make', ['install'], libeventSrc);

run('./configure', [
  '--prefix=' + root,
  '--with-libevent=' + libeventPrefix,
  '--disable-tls',
], root);
run('make', ['-j' + String(process.env.MARINA_BUILD_JOBS || 6)], root);
run('make', ['install'], root);
