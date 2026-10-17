// Per-database settings: port + stored credentials, with best-effort server sync.
import { buildCtx } from './registry.js';
import { renderConfig } from './installer.js';
import { status, start, stop, tcpProbe } from './lifecycle.js';
import { spawnAsync, findBin } from './archive.js';
import { IS_WIN } from './platform.js';
import * as state from './state.js';

export function validatePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error('port must be 1..65535');
  return port;
}

const isRunning = (st) => st === 'running' || st === 'degraded';

export async function changePort(ctx, value) {
  const port = validatePort(value);
  if (port === ctx.port) return { port, same: true, restarted: false };

  if (await tcpProbe(port)) throw new Error(`port ${port} is already in use`);

  const before = await status(ctx);
  const wasRunning = isRunning(before.state);
  if (wasRunning) await stop(ctx, { quiet: true });

  state.setPort(ctx.key, ctx.major, port);
  const next = buildCtx(ctx.engine, { major: ctx.major, version: ctx.version });
  renderConfig(next, { force: true });

  let restarted = false;
  if (wasRunning) {
    await start(next, { quiet: true });
    restarted = true;
  }
  return { port, same: false, restarted };
}

function sqlEscape(value) {
  return String(value ?? '').replace(/'/g, "''");
}

async function mysqlAlter(ctx, oldAccount, nextAccount) {
  const client = findBin(ctx.root, ['mysql', 'mariadb']);
  if (!client) throw new Error('mysql client not found in this package');
  const target = IS_WIN
    ? ['--protocol=TCP', '-h', '127.0.0.1', '-P', String(ctx.port)]
    : [`--socket=${ctx.sockFile}`];
  const auth = [`-u${oldAccount.user || 'root'}`];
  if (oldAccount.password) auth.push(`-p${oldAccount.password}`);

  const user = sqlEscape(nextAccount.user || 'root');
  const pw = sqlEscape(nextAccount.password);
  const sql = [`ALTER USER '${sqlEscape(oldAccount.user || 'root')}'@'localhost' IDENTIFIED BY '${pw}';`];
  if (nextAccount.user && nextAccount.user !== oldAccount.user) {
    sql.push(`CREATE USER IF NOT EXISTS '${user}'@'localhost' IDENTIFIED BY '${pw}';`);
    sql.push(`GRANT ALL PRIVILEGES ON *.* TO '${user}'@'localhost' WITH GRANT OPTION;`);
  }
  sql.push('FLUSH PRIVILEGES;');

  const res = await spawnAsync(client, [...target, ...auth, '-e', sql.join('\n')]);
  if (res.code !== 0) throw new Error(res.stderr.trim() || `client exited ${res.code}`);
}

async function postgresAlter(ctx, account, password) {
  const psql = findBin(ctx.root, ['psql']);
  if (!psql) throw new Error('psql not found in this package');
  const role = String(account.user || 'postgres').replace(/"/g, '""');
  const sql = `ALTER ROLE "${role}" WITH PASSWORD '${sqlEscape(password)}';`;
  const res = await spawnAsync(psql, [
    '-h', '127.0.0.1', '-p', String(ctx.port), '-U', account.user || 'postgres', '-d', 'postgres', '-c', sql,
  ]);
  if (res.code !== 0) throw new Error(res.stderr.trim() || `psql exited ${res.code}`);
}

/**
 * Save credentials for one engine; try to sync the running server where the
 * engine supports it. Returns what was applied and what needs manual action.
 */
export async function changeAccount(ctx, patch) {
  const oldAccount = state.accountOf(ctx.key);
  const nextAccount = { ...oldAccount, ...patch };
  if (patch.user !== undefined && !String(nextAccount.user || '').trim()) {
    throw new Error('account user cannot be empty');
  }

  const applied = [];
  const notes = [];
  const st = await status(ctx).catch(() => ({ state: 'unknown' }));
  const running = isRunning(st.state);
  const changesCreds = patch.password !== undefined || patch.user !== undefined;
  const isMysql = ctx.key === 'mysql' || ctx.key === 'mariadb';

  // server-side changes need a live server; storing a password that the server
  // does not know would break probes and `marina stop`
  if (!running && isMysql && changesCreds) {
    throw new Error(`${ctx.key} is stopped — start it first, then change the account/password`);
  }
  if (!running && ctx.key === 'postgres' && patch.password !== undefined) {
    throw new Error('postgres is stopped — start it first, then change the password');
  }

  if (running && isMysql) {
    // ALTER first: persisting a password the server rejected would make every
    // following probe/stop use the wrong credentials
    try {
      await mysqlAlter(ctx, oldAccount, nextAccount);
    } catch (e) {
      notes.push(`server password NOT changed: ${String(e.message).split('\n')[0]}`);
      return { account: oldAccount, applied, notes };
    }
    state.setAccount(ctx.key, nextAccount);
    applied.push('server');
  } else if (running && ctx.key === 'postgres' && patch.password !== undefined) {
    try {
      await postgresAlter(ctx, oldAccount, nextAccount.password);
    } catch (e) {
      notes.push(`server password NOT changed: ${String(e.message).split('\n')[0]}`);
      return { account: oldAccount, applied, notes };
    }
    state.setAccount(ctx.key, nextAccount);
    applied.push('server');
    notes.push('pg_hba is trust, so the password is stored but not enforced');
  } else if (ctx.key === 'redis' && changesCreds) {
    state.setAccount(ctx.key, nextAccount);
    const next = buildCtx(ctx.engine, { major: ctx.major, version: ctx.version });
    try {
      renderConfig(next, { force: true });
      if (running) {
        await stop(ctx, { quiet: true });
        await start(next, { quiet: true });
        applied.push('restart');
      } else {
        notes.push('applies on next start (requirepass written to redis.conf)');
      }
    } catch (e) {
      // keep state.json and redis.conf on the same (old) password before failing
      state.setAccount(ctx.key, oldAccount);
      try {
        renderConfig(buildCtx(ctx.engine, { major: ctx.major, version: ctx.version }), { force: true });
      } catch {}
      throw e;
    }
  } else {
    state.setAccount(ctx.key, nextAccount);
    if (ctx.key === 'mongodb' || ctx.key === 'memcached') {
      notes.push('stored only; this engine has no marina-managed auth');
    } else if (!running) {
      notes.push('stored only; applies on next start');
    }
  }

  return { account: nextAccount, applied, notes };
}
