// Per-database settings: port + stored credentials, with best-effort server sync.
import { buildCtx } from '../core/registry.js';
import { mysqlAccountSql } from '../engines/_mysql_family.js';
import { renderConfig } from './config.js';
import { inspectService, start, stop, tcpProbe } from './lifecycle.js';
import { spawnAsync, findBin } from '../install/archive.js';
import { host } from '../host/index.js';
import { withInstanceLock } from './instance-lock.js';
import * as state from '../core/state.js';

export { validatePort } from '../core/state.js';

function serviceContext(ctx) {
  const service = inspectService(ctx);
  if (service.unknown) throw new Error(`cannot verify ${ctx.key}@${ctx.major} process ownership`);
  const version = service.runningVersion;
  const current = service.owned && version !== ctx.version ? buildCtx(ctx.engine, { major: ctx.major, version }) : ctx;
  return { current, running: service.owned };
}

async function applyConfig(ctx, next, running, persist, rollback = () => {}) {
  let stopped = false;
  let started = false;
  try {
    if (running) stopped = (await stop(ctx, { quiet: true })).stopped;
    persist();
    if (ctx.engine.renderConfig) renderConfig(next, { force: true });
    if (running) started = (await start(next, { quiet: true })).started;
  } catch (error) {
    try {
      if (started) await stop(next, { quiet: true });
      if (stopped) await start(ctx, { quiet: true });
      rollback();
    } catch (recoveryError) {
      throw new Error(`${error.message}\nCould not restore ${ctx.key}@${ctx.major}: ${recoveryError.message}`, { cause: error });
    }
    throw error;
  }
}

export function changePort(ctx, value) {
  return withInstanceLock(ctx, async () => {
    const port = state.validatePort(value);
    const { current, running } = serviceContext(ctx);
    if (port === current.port) return { port, same: true, restarted: false };
    if (await tcpProbe(port)) throw new Error(`port ${port} is already in use`);

    await applyConfig(
      current,
      { ...current, port },
      running,
      () => state.setPort(ctx.key, ctx.major, port),
      () => state.setPort(ctx.key, ctx.major, current.port),
    );
    return { port, same: false, restarted: running };
  });
}

function sqlEscape(value) {
  return String(value ?? '').replace(/'/g, "''");
}

async function mysqlAlter(ctx, oldAccount, nextAccount) {
  const client = findBin(ctx.root, ['mysql', 'mariadb']);
  if (!client) throw new Error('mysql client not found in this package');
  const target = host.capabilities.unixSocket
    ? [`--socket=${ctx.sockFile}`]
    : ['--protocol=TCP', '-h', '127.0.0.1', '-P', String(ctx.port)];
  const auth = [`-u${oldAccount.user || 'root'}`];
  if (oldAccount.password) auth.push(`-p${oldAccount.password}`);

  const user = nextAccount.user || 'root';
  const sql = ["SET SESSION sql_mode = 'NO_BACKSLASH_ESCAPES';"];
  if (nextAccount.user && nextAccount.user !== oldAccount.user) {
    sql.push(...mysqlAccountSql(ctx, user, nextAccount.password, true));
  }
  sql.push(...mysqlAccountSql(ctx, user, nextAccount.password));

  const res = await spawnAsync(client, [...target, ...auth], { input: sql.join('\n') });
  if (res.code !== 0) throw new Error(res.stderr.trim() || `client exited ${res.code}`);
}

async function postgresAlter(ctx, account, nextAccount) {
  const psql = findBin(ctx.root, ['psql']);
  if (!psql) throw new Error('psql not found in this package');
  const role = String(nextAccount.user || 'postgres').replace(/"/g, '""');
  const sql = `SET standard_conforming_strings = on;\nALTER ROLE "${role}" WITH PASSWORD '${sqlEscape(nextAccount.password)}';`;
  const res = await spawnAsync(psql, [
    '-h', '127.0.0.1', '-p', String(ctx.port), '-U', account.user || 'postgres', '-d', 'postgres', '-X', '-v', 'ON_ERROR_STOP=1',
  ], { input: sql });
  if (res.code !== 0) throw new Error(res.stderr.trim() || `psql exited ${res.code}`);
}

/**
 * Save credentials for one engine; try to sync the running server where the
 * engine supports it. Returns what was applied and what needs manual action.
 */
export function changeAccount(ctx, patch) {
  return withInstanceLock(ctx, () => changeInstanceAccount(ctx, patch));
}

async function changeInstanceAccount(requested, patch) {
  const { current: ctx, running } = serviceContext(requested);
  const oldAccount = state.accountOf(ctx.key, ctx.major);
  const nextAccount = { ...oldAccount, ...patch };
  if (patch.user !== undefined && (typeof nextAccount.user !== 'string' || !nextAccount.user.trim())) {
    throw new Error('account user cannot be empty');
  }
  if (patch.password != null && typeof patch.password !== 'string') throw new Error('password must be a string');

  const applied = [];
  const notes = [];
  const changesCreds = patch.password !== undefined || patch.user !== undefined;
  const isMysql = ctx.key === 'mysql' || ctx.key === 'mariadb';

  if (ctx.key === 'postgres' || ctx.key === 'mongodb' || ctx.key === 'memcached') {
    const mode = ctx.key === 'postgres' ? 'trust: password not enforced' : 'authentication disabled';
    return { account: ctx.engine.account(ctx), applied: [], notes: [mode], error: null };
  }

  // server-side changes need a live server; storing a password that the server
  // does not know would break probes and `marina stop`. A process marina did not
  // start must never receive the credential change either.
  if (!running && isMysql && changesCreds) {
    throw new Error(
      (await tcpProbe(ctx.port))
        ? `${ctx.key} is not running under marina — port ${ctx.port} is held by another process; start ${ctx.key} with marina first`
        : `${ctx.key} is stopped — start it first, then change the account/password`,
    );
  }
  if (!running && ctx.key === 'postgres' && patch.password !== undefined) {
    throw new Error(
      (await tcpProbe(ctx.port))
        ? `postgres is not running under marina — port ${ctx.port} is held by another process; start postgres with marina first`
        : 'postgres is stopped — start it first, then change the password',
    );
  }

  if (running && isMysql) {
    // ALTER first: persisting a password the server rejected would make every
    // following probe/stop use the wrong credentials
    try {
      await mysqlAlter(ctx, oldAccount, nextAccount);
    } catch (e) {
      const error = `server password NOT changed: ${String(e.message).split('\n')[0]}`;
      return { account: oldAccount, applied, notes: [error], error };
    }
    state.setAccount(ctx.key, nextAccount, ctx.major);
    applied.push('server');
  } else if (running && ctx.key === 'postgres' && patch.password !== undefined) {
    try {
      await postgresAlter(ctx, oldAccount, nextAccount);
    } catch (e) {
      const error = `server password NOT changed: ${String(e.message).split('\n')[0]}`;
      return { account: oldAccount, applied, notes: [error], error };
    }
    state.setAccount(ctx.key, nextAccount, ctx.major);
    applied.push('server');
    notes.push('pg_hba is trust, so the password is stored but not enforced');
  } else if (ctx.key === 'redis' && changesCreds) {
    const next = { ...ctx, account: nextAccount, user: nextAccount.user, password: nextAccount.password ?? '' };
    await applyConfig(
      ctx,
      next,
      running,
      () => state.setAccount(ctx.key, nextAccount, ctx.major),
      () => state.setAccount(ctx.key, oldAccount, ctx.major),
    );
    if (running) applied.push('restart');
    else notes.push('applies on next start (requirepass written to redis.conf)');
  } else {
    state.setAccount(ctx.key, nextAccount, ctx.major);
    if (ctx.key === 'mongodb' || ctx.key === 'memcached') {
      notes.push('stored only; this engine has no marina-managed auth');
    } else if (!running) {
      notes.push('stored only; applies on next start');
    }
  }

  return { account: nextAccount, applied, notes };
}
