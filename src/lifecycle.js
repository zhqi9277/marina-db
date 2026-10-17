// Service lifecycle: start / stop / restart / status / logs.
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { spawnAsync, findBin } from './archive.js';
import { ensureDirs } from './paths.js';
import { staleConfigReferences } from './configcheck.js';
import { ok, warn, info, color } from './ui.js';
import * as state from './state.js';

export function tcpProbe(port, host = '127.0.0.1', timeout = 700) {
  return new Promise((resolve) => {
    const sock = net.connect({ port: Number(port), host });
    const done = (result) => {
      sock.destroy();
      resolve(result);
    };
    sock.setTimeout(timeout);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

export function pidAlive(pid) {
  if (!pid || !Number.isFinite(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

function realpathOf(target) {
  try {
    return fs.realpathSync(target);
  } catch {
    return null;
  }
}

/**
 * Identity of a live process: command line and/or cwd, or null when it cannot
 * be inspected. Linux is served by /proc; elsewhere `ps` is tried first and
 * `lsof` is the fallback (some sandboxes forbid exec'ing ps).
 */
export function processDetails(pid) {
  if (process.platform === 'win32' || !pidAlive(pid)) return null;
  try {
    const argv = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
    let cwd = null;
    try {
      cwd = fs.realpathSync(fs.readlinkSync(`/proc/${pid}/cwd`));
    } catch {}
    if (argv.length || cwd) return { command: argv.join(' '), cwd };
  } catch {}
  try {
    const res = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', timeout: 2000 });
    if (!res.error && res.status === 0) {
      const command = (res.stdout || '').trim();
      if (command) return { command, cwd: null };
    }
  } catch {}
  try {
    const res = spawnSync('lsof', ['-p', String(pid), '-a', '-d', 'cwd', '-Fn'], { encoding: 'utf8', timeout: 3000 });
    if (!res.error && res.status === 0) {
      const line = (res.stdout || '').split('\n').find((row) => row.startsWith('n'));
      if (line) return { command: null, cwd: line.slice(1) };
    }
  } catch {}
  return null;
}

/**
 * Root-independent marina layout markers. A moved project keeps the same
 * engines/<key>/<major>/<version> · data/<key>/<major> · etc/... · run/... shape
 * under the old root, so these let us recognise (and stop) pre-move processes.
 */
function marinaLayout(ctx) {
  const sep = path.sep;
  const key = ctx.engine?.key || ctx.key;
  const major = ctx.major === undefined || ctx.major === null ? '' : String(ctx.major);
  if (!key || !major) return { needles: [], suffixes: [] };
  const data = `${sep}data${sep}${key}${sep}${major}`;
  return {
    needles: [
      `${sep}engines${sep}${key}${sep}`,
      `${data}${sep}`,
      `${sep}etc${sep}${key}${sep}${major}${sep}`,
      `${sep}run${sep}${key}-${major}.pid`,
    ],
    // a process may sit exactly on the datadir (redis chdir's into it)
    suffixes: [data],
  };
}

/** Match one process identity record (command line and/or cwd) against ctx. */
function matchesInstall(details, ctx) {
  const texts = [details.command, details.cwd].filter(Boolean);
  if (!texts.length) return true; // nothing to judge by -> keep the old trust
  const roots = [ctx.root, ctx.dataDir, ctx.confFile, ctx.logFile, ctx.pidFile]
    .filter(Boolean)
    .flatMap((root) => {
      const resolved = path.resolve(root);
      const real = realpathOf(root);
      return real && real !== resolved ? [resolved, real] : [resolved];
    });
  if (roots.some((root) => texts.some((text) => text.includes(root)))) return true;
  if (details.cwd && roots.some((root) => details.cwd === root || details.cwd.startsWith(root + path.sep))) return true;

  const { needles, suffixes } = marinaLayout(ctx);
  return texts.some(
    (text) =>
      needles.some((needle) => text.includes(needle)) ||
      suffixes.some((suffix) => text === suffix || text.endsWith(suffix)),
  );
}

/**
 * Does `pid` really belong to this install? A pid file can outlive its process
 * (or be reused by an unrelated one), and blindly signalling it would take down
 * a process marina never started. Besides the live paths we also accept the
 * marina layout anywhere (moved installs), while system binaries such as
 * /usr/local/bin/mysqld never match `engines/<key>/`.
 *
 * `details` is injectable so tests can simulate an identity without exec'ing ps.
 */
export function pidOwnedBy(pid, ctx, details = processDetails(pid)) {
  if (!Number.isFinite(pid) || !pidAlive(pid)) return false;
  // Windows has no portable command-line lookup; keep trusting the pid file there.
  if (process.platform === 'win32') return true;
  // if the process cannot be inspected, keep the old pid-file trust instead of
  // leaving a service running that the user asked to stop
  if (!details) return true;
  return matchesInstall(details, ctx);
}

export async function healthy(ctx) {
  try {
    const verdict = await ctx.engine.probe(ctx);
    if (verdict === true) return true;
    if (verdict === false) return false;
  } catch {
    /* engine probe unavailable -> fall through to TCP */
  }
  return tcpProbe(ctx.port);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function bootReady(ctx) {
  const pid = readPid(ctx);
  if (!pid || !pidAlive(pid)) return false;
  return tcpProbe(ctx.port);
}

async function waitFor(fn, timeoutMs, interval = 300) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await fn()) return true;
    await sleep(interval);
  }
  return false;
}

function readPid(ctx) {
  try {
    return ctx.engine.readPid(ctx);
  } catch {
    return null;
  }
}

function cleanRuntimeFiles(ctx) {
  for (const f of [ctx.pidFile, ctx.sockFile, `${ctx.sockFile}.lock`]) {
    if (f && fs.existsSync(f)) {
      try {
        fs.rmSync(f, { force: true });
      } catch {}
    }
  }
  // engine-specific stale runtime state (e.g. PostgreSQL's postmaster.pid)
  try {
    ctx.engine?.cleanRuntime?.(ctx);
  } catch {}
}

export function tailLog(ctx, lines = 12) {
  const file = ctx.engine.logFile?.(ctx) || ctx.logFile;
  try {
    const content = fs.readFileSync(file, 'utf8').trimEnd().split('\n');
    return content.slice(-lines).join('\n');
  } catch {
    return '';
  }
}

function serverCommand(ctx) {
  if (ctx.engine.startCommand) return ctx.engine.startCommand(ctx);
  const bin = findBin(ctx.root, ctx.engine.serverBin || []);
  if (!bin) throw new Error(`cannot find ${ctx.engine.serverBin?.join('/')} under ${ctx.root}`);
  return { cmd: bin, args: ctx.engine.startArgs(ctx), foreground: true };
}

export async function start(ctx, { quiet = false, timeoutMs = 30000 } = {}) {
  ensureDirs();
  if (!ctx.root) throw new Error(`package payload for ${ctx.key}@${ctx.version} is missing (reinstall)`);

  // fail fast instead of waiting 30s when the generated config still points at
  // another marina root (the project directory was moved)
  const stale = staleConfigReferences(ctx);
  if (stale.length) {
    throw new Error(
      `${ctx.engine.key} config points to a different marina root — run: marina reconfig ${ctx.engine.key}@${ctx.major}\n` +
        `  stale path: ${stale[0]}`,
    );
  }

  if (await healthy(ctx)) {
    if (!quiet) ok(`${ctx.engine.label} ${ctx.version} is already running on port ${ctx.port}`);
    return { already: true, pid: readPid(ctx) };
  }

  const pid = readPid(ctx);
  if (pidAlive(pid)) {
    if (pidOwnedBy(pid, ctx)) {
      if (!quiet) warn(`stale ${ctx.engine.label} pid ${pid} is alive but not answering — terminating it`);
      try { process.kill(pid, 'SIGKILL'); } catch {}
      if (!(await waitFor(() => !pidAlive(pid), 5000))) {
        throw new Error(`${ctx.engine.label} pid ${pid} did not exit after SIGKILL — stop it manually: kill -9 ${pid}`);
      }
    } else if (!quiet) {
      warn(`pid ${pid} in ${ctx.pidFile} belongs to another process (pid reuse) — removing the stale pid file without signalling it`);
    }
  }
  cleanRuntimeFiles(ctx);

  const spec = serverCommand(ctx);
  const startedAt = Date.now();
  let spawnedPid = null;
  if (!quiet) info(`starting ${ctx.engine.label} ${ctx.version} on port ${ctx.port}`);
  if (!spec.foreground) {
    // wrapper (e.g. pg_ctl -w) — it daemonizes; ignore stdio so the daemon does
    // not inherit our pipes and leak server logs into the CLI output
    await new Promise((resolve, reject) => {
      const child = spawn(spec.cmd, spec.args, { cwd: ctx.root, stdio: 'ignore' });
      child.on('error', reject);
      child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${path.basename(spec.cmd)} exited ${code}`))));
    });
  } else {
    const child = spawn(spec.cmd, spec.args, { cwd: ctx.root, detached: true, stdio: 'ignore' });
    // wait for the exec result: an unhandled 'error' event would crash the CLI,
    // and a missing/broken binary must fail now instead of after the timeout
    const spawnError = await new Promise((resolve) => {
      child.once('spawn', () => resolve(null));
      child.once('error', resolve);
    });
    child.unref();
    if (spawnError) throw new Error(`failed to start ${ctx.engine.label}: ${spawnError.message}`);
    spawnedPid = child.pid;
  }

  // readiness = our own pid file is alive *and* the port accepts connections.
  // Polling this is much cheaper than spawning a client probe every 300ms.
  const up = await waitFor(() => bootReady(ctx), timeoutMs, 200);
  if (!up) {
    // do not leak the process we just started: a server that never becomes
    // ready keeps holding the port/datadir, and the retry would fail
    for (const candidate of new Set([readPid(ctx), spawnedPid])) {
      if (pidAlive(candidate) && pidOwnedBy(candidate, ctx)) {
        try { process.kill(candidate, 'SIGKILL'); } catch {}
        await waitFor(() => !pidAlive(candidate), 3000);
      }
    }
    const tail = tailLog(ctx);
    cleanRuntimeFiles(ctx);
    throw new Error(
      `${ctx.engine.label} did not become ready within ${Math.round(timeoutMs / 1000)}s\n` +
      (tail ? `--- last log lines (${ctx.logFile}) ---\n${tail}` : `(no log at ${ctx.logFile})`),
    );
  }
  const newPid = readPid(ctx);
  if (!quiet) {
    const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
    ok(`${ctx.engine.label} ${ctx.version} up on port ${ctx.port}${newPid ? ` (pid ${newPid})` : ''} in ${secs}s`);
    if (!(await healthy(ctx))) warn(`${ctx.engine.label} accepts TCP but its probe still fails — check the client binary`);
  }
  return { started: true, pid: newPid, seconds: (Date.now() - startedAt) / 1000 };
}

export async function stop(ctx, { quiet = false } = {}) {
  const pid = readPid(ctx);
  const running = await healthy(ctx);
  if (!running && !pidAlive(pid)) {
    cleanRuntimeFiles(ctx);
    if (!quiet) info(`${ctx.engine.label} ${ctx.version} is already stopped`);
    return { already: true };
  }

  if (!quiet) info(`stopping ${ctx.engine.label} ${ctx.version}`);

  // after a directory move the generated config points at the old root: talking
  // to that socket/port is pointless, go straight to the pid
  const stale = staleConfigReferences(ctx);
  if (stale.length && !quiet) {
    warn(`${ctx.engine.key} config points to ${stale[0]} — run: marina reconfig ${ctx.engine.key}@${ctx.major}`);
  }

  let spec = null;
  if (!stale.length) {
    try {
      spec = ctx.engine.stopCommand?.(ctx) || null;
    } catch {
      spec = null;
    }
    if (spec) {
      let res = null;
      try {
        res = await spawnAsync(spec.cmd, spec.args, { cwd: ctx.root });
      } catch (e) {
        // a missing/broken shutdown helper must not take the pid fallback down
        if (!quiet) warn(`graceful stop command failed: ${path.basename(spec.cmd)} could not run: ${String(e.message).split('\n')[0]}`);
      }
      // a failed shutdown helper should not stay silent; the pid fallback below
      // still gets a chance to stop the server
      if (res && res.code !== 0 && !quiet) {
        const first = (res.stderr || '').trim().split('\n')[0];
        warn(`graceful stop command failed: ${path.basename(spec.cmd)} exited ${res.code}${first ? `: ${first}` : ''}`);
      }
    }
  }

  let stopped = stale.length ? false : await waitFor(async () => !(await healthy(ctx)), 15000);

  // The probe can be broken and the pid file can outlive its server: a live
  // process recorded in our pid file must still actually be terminated, and its
  // death must be confirmed — otherwise stop() reports success for a server that
  // is still holding the port/datadir.
  if (pidAlive(pid)) {
    if (!pidOwnedBy(pid, ctx)) {
      if (!quiet) warn(`pid ${pid} belongs to another process (pid reuse) — removing the stale pid file without signalling it`);
    } else {
      try { process.kill(pid, 'SIGTERM'); } catch {}
      stopped = await waitFor(() => !pidAlive(pid), 15000);
      if (!stopped) {
        if (!quiet) warn('graceful stop timed out — sending SIGKILL');
        try { process.kill(pid, 'SIGKILL'); } catch {}
        stopped = await waitFor(() => !pidAlive(pid), 5000);
      }
      if (!stopped) {
        throw new Error(`${ctx.engine.label} ${ctx.version} is still running as pid ${pid} — stop it manually: kill -9 ${pid}`);
      }
    }
  } else {
    stopped = true; // no live pid left to signal
  }
  cleanRuntimeFiles(ctx);
  if (!quiet) ok(`${ctx.engine.label} ${ctx.version} stopped`);
  return { stopped: true };
}

export async function restart(ctx, opts = {}) {
  await stop(ctx, opts);
  return start(ctx, opts);
}

export async function status(ctx) {
  const pid = readPid(ctx);
  const alive = pidAlive(pid);
  const portOpen = await tcpProbe(ctx.port);
  const isHealthy = await healthy(ctx);

  let code = 'stopped';
  if (isHealthy) code = 'running';
  else if (alive) code = 'degraded';
  else if (portOpen) code = 'port-busy';

  return {
    key: ctx.key,
    label: ctx.engine.label,
    major: ctx.major,
    version: ctx.version,
    port: ctx.port,
    pid: alive ? pid : null,
    state: code,
    healthy: isHealthy,
  };
}

export function stateBadge(code) {
  switch (code) {
    case 'running': return color.green('● running');
    case 'degraded': return color.yellow('◐ degraded');
    case 'inactive': return color.gray('◌ not active');
    case 'port-busy': return color.magenta('◑ port busy');
    default: return color.gray('○ stopped');
  }
}

export const _internal = { waitFor, cleanRuntimeFiles, readPid };
