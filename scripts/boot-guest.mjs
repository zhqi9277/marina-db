#!/usr/bin/env node
// Boot marina's kernel and rootfs in the foreground. Ctrl-C stops the guest.
import { spawn } from 'node:child_process';
import { qemuArgv } from '../src/kernel-guest.js';

const argv = qemuArgv();
const child = spawn(argv[0], argv.slice(1), { stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 1));
