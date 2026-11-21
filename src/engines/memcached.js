// Memcached: no config file, no datadir — flags only.
import fs from 'node:fs';
import { mkdirp } from '../core/paths.js';

export default {
  key: 'memcached',
  label: 'Memcached',
  kind: 'kv',
  manifestName: 'memcached',
  defaultMajor: '1',
  defaultPort: 11211,
  serverBin: ['memcached'],
  markers: ['bin/memcached'],
  clientBins: ['memcached', 'memcached-tool'],
  primaryClient: 'memcached',
  hasDataDir: false,

  readPid(ctx) {
    try {
      const pid = parseInt(fs.readFileSync(ctx.pidFile, 'utf8').trim(), 10);
      return Number.isFinite(pid) ? pid : null;
    } catch {
      return null;
    }
  },

  renderConfig(ctx) {
    return null;
  },

  async init(ctx) {
    mkdirp(ctx.logDir);
    return { skipped: true };
  },

  clientArgs() {
    return [];
  },

  startArgs(ctx) {
    const args = [
      '-l', '127.0.0.1',
      '-p', String(ctx.port),
      '-m', '64',
      '-c', '1024',
      '-P', ctx.pidFile,
      '-d',
    ];
    if (typeof process.getuid === 'function' && process.getuid() === 0) args.push('-u', 'nobody');
    return args;
  },

  stopCommand() {
    return null;
  },

  account(ctx) {
    return {
      user: null,
      password: null,
      mode: 'disabled',
      note: 'stored only; memcached has no authentication',
    };
  },

  async probe() {
    return null; // TCP is the only signal
  },
};
