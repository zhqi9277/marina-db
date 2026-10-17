// PostgreSQL: initdb for the cluster, pg_ctl to run it.
import fs from 'node:fs';
import path from 'node:path';
import { spawnAsync, findBin } from '../archive.js';
import { mkdirp } from '../paths.js';
import { IS_WIN } from '../platform.js';

export default {
  key: 'postgres',
  label: 'PostgreSQL',
  kind: 'sql',
  manifestName: 'postgresql',
  defaultMajor: '17',
  defaultPort: 5432,
  serverBin: ['postgres'],
  markers: ['bin/postgres', 'bin/initdb', 'bin/pg_ctl'],
  clientBins: ['psql', 'pg_dump', 'pg_restore', 'createdb', 'pg_isready', 'pg_ctl', 'initdb'],
  primaryClient: 'psql',
  hasDataDir: true,

  pidPath(ctx) {
    return path.join(ctx.dataDir, 'postmaster.pid');
  },

  readPid(ctx) {
    try {
      const pid = parseInt(fs.readFileSync(path.join(ctx.dataDir, 'postmaster.pid'), 'utf8').split('\n')[0], 10);
      return Number.isFinite(pid) ? pid : null;
    } catch {
      return null;
    }
  },

  // postgres has no my.cnf equivalent we own; connection settings live in the
  // cluster config, we pass runtime flags through pg_ctl -o instead.
  confPath(ctx) {
    return path.join(ctx.dataDir, 'postgresql.conf');
  },

  renderConfig() {
    return null; // nothing to render; postgres writes its own files
  },

  async init(ctx) {
    if (fs.existsSync(path.join(ctx.dataDir, 'PG_VERSION'))) return { skipped: true };
    mkdirp(ctx.dataDir);
    mkdirp(ctx.logDir);
    const initdb = findBin(ctx.root, ['initdb']);
    if (!initdb) throw new Error('initdb not found in package');
    const res = await spawnAsync(initdb, [
      '-D', ctx.dataDir,
      '-U', 'postgres',
      '--auth-local=trust',
      '--auth-host=trust',
      '-E', 'UTF8',
      '--locale=C',
    ]);
    if (res.code !== 0) throw new Error(`initdb failed:\n${res.stderr.trim()}`);
    return { created: true };
  },

  clientArgs(ctx) {
    return ['-h', '127.0.0.1', '-p', String(ctx.port), '-U', 'postgres'];
  },

  startCommand(ctx) {
    const pgctl = findBin(ctx.root, ['pg_ctl']);
    if (!pgctl) throw new Error('pg_ctl not found in package');
    // keep postgres unix sockets in their own run subdir instead of run/
    const sockDir = path.join(ctx.runDir, 'postgres');
    const socketFlag = IS_WIN ? '' : `-k ${sockDir}`;
    if (!IS_WIN) mkdirp(sockDir);
    return {
      cmd: pgctl,
      args: [
        '-D', ctx.dataDir,
        '-l', ctx.logFile,
        '-o', `-p ${ctx.port} ${socketFlag} -h 127.0.0.1`,
        '-w',
        'start',
      ],
    };
  },

  stopCommand(ctx) {
    const pgctl = findBin(ctx.root, ['pg_ctl']);
    if (!pgctl) return null;
    return { cmd: pgctl, args: ['-D', ctx.dataDir, '-m', 'fast', '-w', 'stop'] };
  },

  account() {
    return {
      user: 'postgres',
      password: null,
      mode: 'trust',
      note: 'initdb --auth-local=trust --auth-host=trust',
    };
  },

  async probe(ctx) {
    const isready = findBin(ctx.root, ['pg_isready']);
    if (!isready) return null;
    const res = await spawnAsync(isready, ['-h', '127.0.0.1', '-p', String(ctx.port)]);
    return res.code === 0;
  },
};
