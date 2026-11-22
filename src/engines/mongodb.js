// MongoDB: no datadir bootstrap; mongod --fork writes the pid file itself.
import fs from 'node:fs';
import { spawnAsync, findBin } from '../install/archive.js';
import { mkdirp } from '../core/paths.js';
import { host } from '../host/index.js';

export default {
  key: 'mongodb',
  label: 'MongoDB',
  kind: 'doc',
  manifestName: 'mongodb',
  defaultMajor: '7.0',
  defaultPort: 27017,
  serverBin: ['mongod'],
  markers: ['bin/mongod'],
  clientBins: ['mongosh', 'mongod', 'mongos', 'mongoexport', 'mongoimport', 'mongodump', 'mongorestore'],
  primaryClient: 'mongosh',
  hasDataDir: true,
  recordPid: !host.capabilities.fork,

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
    mkdirp(ctx.dataDir);
    mkdirp(ctx.logDir);
    return { skipped: true };
  },

  clientArgs(ctx) {
    const args = ['--host', '127.0.0.1', '--port', String(ctx.port)];
    const acct = ctx.account;
    if (acct?.user) args.push('--username', acct.user, '--password', acct.password || '', '--authenticationDatabase', 'admin');
    return args;
  },

  startArgs(ctx) {
    const args = [
      '--dbpath', ctx.dataDir,
      '--port', String(ctx.port),
      '--bind_ip', '127.0.0.1',
      '--logpath', ctx.logFile,
      '--logappend',
    ];
    if (host.capabilities.fork) args.push('--fork', '--pidfilepath', ctx.pidFile);
    return args;
  },

  stopCommand(ctx) {
    if (host.capabilities.posixSignals) return null; // mongod shuts down cleanly on SIGTERM
    const cmd = findBin(ctx.root, ['mongosh']);
    if (!cmd) return null;
    return {
      cmd,
      args: [...this.clientArgs(ctx), '--quiet', '--norc', '--eval',
        'try { db.adminCommand({ shutdown: 1 }); } catch (e) { if (e.name !== "MongoNetworkError") throw e; }'],
    };
  },

  account(ctx) {
    return {
      user: null,
      password: null,
      mode: 'disabled',
      note: 'authentication is not enabled by marina',
    };
  },

  async probe(ctx) {
    const mongosh = findBin(ctx.root, ['mongosh']);
    if (!mongosh) return null;
    const args = ['--quiet', '--host', '127.0.0.1', '--port', String(ctx.port)];
    if (ctx.account?.user) args.push('--username', ctx.account.user, '--password', ctx.account.password || '', '--authenticationDatabase', 'admin');
    args.push('--eval', 'db.runCommand({ping:1}).ok');
    const res = await spawnAsync(mongosh, args);
    return res.code === 0 && /1/.test(res.stdout);
  },
};
