// Service lifecycle: start / stop / restart / status / logs.
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { spawnAsync, findBin } from '../install/archive.js';
import { host } from '../host/index.js';
import { ensureDirs } from '../core/paths.js';
import { clientEnv } from '../core/env.js';
import { ok, warn, info, color } from '../ui/console.js';
import { buildCtx, majorPick } from '../core/registry.js';
import { withInstanceLock } from './instance-lock.js';

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
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/**
 * Identity of a live process: command line and/or cwd, or null when it cannot
 * be inspected. The host reads /proc, ps/lsof, or Win32_Process.CommandLine.
 */
export function processDetails(pid) {
  if (!pidAlive(pid)) return null;
  return host.processDetails(pid);
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
  return !!details && pidAlive(pid) && matchesService(details, ctx);
}

function matchesService(details, ctx) {
  return host.matchesInstall(details, ctx);
}

export function inspectService(ctx) {
  const pid = readPid(ctx);
  const alive = pidAlive(pid);
  if (!alive) return { pid, alive, owned: false, unknown: false, runningVersion: null };
  const details = processDetails(pid);
  const unknown = !details?.command && !details?.cwd;
  const owned = !unknown && matchesService(details, ctx);
  const runningVersion = owned
    ? host.installVersion(details, ctx) || majorPick(ctx.engine, ctx.major)?.version || ctx.version
    : null;
  return { pid, alive, owned, unknown, runningVersion };
}

/**
 * An open port is not proof that marina's server is up: another program (a
 * system mysqld, a docker-compose database, a VPN tool...) can hold the same
 * port. A service is only "running" when the pid marina recorded is alive,
 * still belongs to this install, and the server answers on its protocol.
 */
export function serviceState({ owned = false, answered = false, portOpen = false } = {}) {
  if (owned) return answered ? 'running' : 'degraded';
  if (portOpen) return 'port-busy';
  return 'stopped';
}

async function engineAnswers(ctx) {
  try {
    const verdict = await ctx.engine.probe?.(ctx);
    if (verdict === true) return true;
    if (verdict === false) return false;
  } catch {
    /* engine probe unavailable -> fall through to TCP */
  }
  return tcpProbe(ctx.port);
}

/**
 * Full runtime picture for one ctx: `state` is one of running / degraded /
 * inactive / unknown / port-busy / stopped. `pid` is set for the verified process.
 */
export async function probeState(ctx, { instance = false } = {}) {
  const service = inspectService(ctx);
  const { pid, owned, unknown, runningVersion } = service;
  const portOpen = await tcpProbe(ctx.port);
  const otherVersion = owned && runningVersion !== ctx.version;
  const inactive = otherVersion && !instance;
  const probeCtx = otherVersion && instance ? contextForRunningVersion(ctx, runningVersion) : ctx;
  const answered = owned && !inactive && portOpen ? await engineAnswers(probeCtx) : false;
  return {
    ...service,
    state: unknown ? 'unknown' : inactive ? 'inactive' : serviceState({ owned, answered, portOpen }),
    pid: owned && !inactive ? pid : null,
    portOpen,
  };
}

export async function healthy(ctx) {
  return (await probeState(ctx)).state === 'running';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function bootReady(ctx) {
  const pid = readPid(ctx);
  return pidAlive(pid) && await tcpProbe(ctx.port) && pidOwnedBy(pid, ctx);
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
  for (const f of [ctx.pidFile, ctx.sockFile, ctx.sockFile && `${ctx.sockFile}.lock`]) {
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

// MariaDB keeps compatibility aliases (mysqladmin, mysqld_safe, ...) that print a
// deprecation notice on every run. When such a helper fails, that notice is the
// first stderr line and would hide the real error (connection refused, access
// denied...). Skip it so the warning stays actionable.
const STDERR_NOISE = /deprecated program name|will be removed in a future release|using a password on the command line/i;

export function firstDiagnostic(text) {
  const lines = String(text || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.find((line) => !STDERR_NOISE.test(line)) || lines[0] || '';
}

/** Shell command that shows which process owns a port (used in conflict errors). */
export function portHint(port) {
  return host.id === 'win32'
    ? `netstat -ano | findstr :${port}`
    : `lsof -nP -iTCP:${port} -sTCP:LISTEN`;
}

function serverCommand(ctx) {
  if (ctx.engine.startCommand) return ctx.engine.startCommand(ctx);
  const bin = findBin(ctx.root, ctx.engine.serverBin || []);
  if (!bin) throw new Error(`cannot find ${ctx.engine.serverBin?.join('/')} under ${ctx.root}`);
  return { cmd: bin, args: ctx.engine.startArgs(ctx), foreground: true, recordPid: ctx.engine.recordPid };
}

export function start(ctx, opts) {
  return withInstanceLock(ctx, () => startService(ctx, opts));
}

async function startService(ctx, { quiet = false, timeoutMs = 30000 } = {}) {
  ensureDirs();
  if (!ctx.root) throw new Error(`package payload for ${ctx.key}@${ctx.version} is missing (reinstall)`);

  const current = await probeState(ctx);
  if (current.state === 'unknown') throw new Error(`cannot verify ${ctx.key}@${ctx.major} process ownership`);
  if (current.state === 'inactive') {
    throw new Error(`${ctx.key}@${current.runningVersion} is running for this instance — stop it before starting ${ctx.version}`);
  }
  if (current.state === 'running') {
    if (!quiet) ok(`${ctx.engine.label} ${ctx.version} is already running on port ${ctx.port}`);
    return { already: true, pid: current.pid };
  }
  if (current.state === 'port-busy') {
    // starting would only time out 30s later on EADDRINUSE; fail now and say
    // which process is squatting on the port (one line: callers print the first)
    throw new Error(
      `${ctx.engine.label} ${ctx.version} cannot start: port ${ctx.port} is already in use by a process marina did not start — inspect: ${portHint(ctx.port)}`,
    );
  }

  const pid = readPid(ctx);
  if (pidAlive(pid)) {
    if (pidOwnedBy(pid, ctx)) {
      if (!quiet) warn(`stale ${ctx.engine.label} pid ${pid} is alive but not answering — terminating it`);
      host.terminate(pid, 'kill');
      if (!(await waitFor(() => !pidAlive(pid), 5000))) {
        throw new Error(`${ctx.engine.label} pid ${pid} did not exit after ${host.forceVerb} — stop it manually: ${host.killHint(pid)}`);
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
      const child = spawn(spec.cmd, spec.args, { cwd: ctx.root, stdio: 'ignore', env: clientEnv() });
      child.on('error', reject);
      child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${path.basename(spec.cmd)} exited ${code}`))));
    });
  } else {
    const child = spawn(spec.cmd, spec.args, { cwd: ctx.root, detached: true, stdio: 'ignore', env: clientEnv() });
    // wait for the exec result: an unhandled 'error' event would crash the CLI,
    // and a missing/broken binary must fail now instead of after the timeout
    const spawnError = await new Promise((resolve) => {
      child.once('spawn', () => resolve(null));
      child.once('error', resolve);
    });
    child.unref();
    if (spawnError) throw new Error(`failed to start ${ctx.engine.label}: ${spawnError.message}`);
    spawnedPid = child.pid;
    if (spec.recordPid) {
      try {
        fs.writeFileSync(ctx.pidFile, `${spawnedPid}\n`);
      } catch (error) {
        child.kill();
        throw error;
      }
    }
  }

  // readiness = our own pid file is alive *and* the port accepts connections.
  // Polling this is much cheaper than spawning a client probe every 300ms.
  const up = await waitFor(() => bootReady(ctx), timeoutMs, 200);
  if (!up) {
    // do not leak the process we just started: a server that never becomes
    // ready keeps holding the port/datadir, and the retry would fail
    const pid = readPid(ctx);
    for (const candidate of new Set([pid, spawnedPid])) {
      if (pidAlive(candidate) && pidOwnedBy(candidate, ctx)) {
        host.terminate(candidate, 'kill');
        await waitFor(() => !pidAlive(candidate), 3000);
      }
    }
    const tail = tailLog(ctx);
    if (!pidAlive(pid) && !pidAlive(spawnedPid)) cleanRuntimeFiles(ctx);
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

export function stop(ctx, opts) {
  return withInstanceLock(ctx, () => stopService(ctx, opts));
}

function contextForRunningVersion(ctx, version) {
  return buildCtx(ctx.engine, { major: ctx.major, version, port: ctx.port, account: ctx.account });
}

async function stopService(ctx, { quiet = false, instance = false } = {}) {
  const { pid, alive, owned, unknown, runningVersion } = inspectService(ctx);
  if (unknown) throw new Error(`cannot verify ${ctx.key}@${ctx.major} process ownership`);
  if (owned && runningVersion !== ctx.version && !instance) {
    if (!quiet) info(`${ctx.key}@${runningVersion} is running for this instance`);
    return { already: true, stopped: false, runningVersion };
  }
  if (owned && runningVersion !== ctx.version) ctx = contextForRunningVersion(ctx, runningVersion);
  const portOpen = await tcpProbe(ctx.port);

  // Nothing marina recorded is alive. A port that still answers therefore
  // belongs to somebody else: signalling it would take down a database marina
  // never started, and reporting "stopped" would be a lie (the port stays up).
  if (!owned) {
    if (alive && !quiet) {
      warn(`pid ${pid} in ${ctx.pidFile} belongs to another process (pid reuse) — removing the stale pid file without signalling it`);
    }
    cleanRuntimeFiles(ctx);
    if (portOpen) {
      if (!quiet) {
        warn(
          `${ctx.engine.label} ${ctx.version} is not running — port ${ctx.port} is held by another process marina did not start (${portHint(ctx.port)})`,
        );
      }
      return { already: true, portBusy: true, stopped: false };
    }
    if (!quiet) info(`${ctx.engine.label} ${ctx.version} is already stopped`);
    return { already: true, stopped: false };
  }

  if (!quiet) info(`stopping ${ctx.engine.label} ${ctx.version}`);

  let spec = null;
  try {
    spec = ctx.engine.stopCommand?.(ctx) || null;
  } catch {
    spec = null;
  }

  // Ask the server to shut down cleanly. Its exit is confirmed through the pid
  // file instead of the health probe: a broken probe (moved install, missing
  // client binary) must not turn a dead server into "still running" or vice
  // versa, and a failed helper must not cost the 15s wait before signalling.
  let gracefulOk = false;
  if (spec) {
    let res = null;
    try {
      res = await spawnAsync(spec.cmd, spec.args, { cwd: ctx.root });
      gracefulOk = res.code === 0;
    } catch (e) {
      // a missing/broken shutdown helper must not take the pid fallback down
      if (!quiet) warn(`graceful stop command failed: ${path.basename(spec.cmd)} could not run: ${firstDiagnostic(e.message)}`);
    }
    // a failed shutdown helper should not stay silent; the pid fallback below
    // still gets a chance to stop the server
    if (res && res.code !== 0 && !quiet) {
      const detail = firstDiagnostic(res.stderr);
      warn(`graceful stop command failed: ${path.basename(spec.cmd)} exited ${res.code}${detail ? `: ${detail}` : ''}`);
    }
  }

  let stopped = gracefulOk ? await waitFor(() => !pidAlive(pid), 15000) : false;
  if (!stopped) {
    if (pidOwnedBy(pid, ctx)) host.terminate(pid, 'term');
    stopped = await waitFor(() => !pidAlive(pid), 10000);
    if (!stopped) {
      if (!quiet) warn(`graceful stop timed out — sending ${host.forceVerb}`);
      if (pidOwnedBy(pid, ctx)) host.terminate(pid, 'kill');
      stopped = await waitFor(() => !pidAlive(pid), 5000);
    }
  }
  if (!stopped) {
    throw new Error(`${ctx.engine.label} ${ctx.version} is still running as pid ${pid} — stop it manually: ${host.killHint(pid)}`);
  }

  cleanRuntimeFiles(ctx);
  if (await tcpProbe(ctx.port)) {
    if (!quiet) warn(`${ctx.engine.label} ${ctx.version} stopped, but port ${ctx.port} is still in use by another process`);
    return { stopped: true, portBusy: true };
  }
  if (!quiet) ok(`${ctx.engine.label} ${ctx.version} stopped`);
  return { stopped: true };
}

export async function restart(ctx, opts = {}) {
  return withInstanceLock(ctx, async () => {
    await stopService(ctx, opts);
    return startService(ctx, opts);
  });
}

export async function status(ctx, opts) {
  const probe = await probeState(ctx, opts);

  return {
    key: ctx.key,
    label: ctx.engine.label,
    major: ctx.major,
    version: ctx.version,
    port: ctx.port,
    pid: probe.pid,
    runningVersion: probe.runningVersion,
    state: probe.state,
    healthy: probe.state === 'running',
  };
}

export function stateBadge(code) {
  switch (code) {
    case 'running': return color.green('● running');
    case 'degraded': return color.yellow('◐ degraded');
    case 'inactive': return color.gray('◌ not active');
    case 'port-busy': return color.magenta('◑ port busy');
    case 'unknown': return color.yellow('? unknown');
    default: return color.gray('○ stopped');
  }
}

export const _internal = { waitFor, cleanRuntimeFiles, readPid };
