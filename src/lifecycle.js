// Service lifecycle: start / stop / restart / status / logs.
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
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

export async function start(ctx, { quiet = false } = {}) {
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
    if (!quiet) warn(`stale ${ctx.engine.label} pid ${pid} is alive but not answering — terminating it`);
    try { process.kill(pid, 'SIGKILL'); } catch {}
    await sleep(700);
  }
  cleanRuntimeFiles(ctx);

  const spec = serverCommand(ctx);
  const startedAt = Date.now();
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
    child.unref();
  }

  // readiness = our own pid file is alive *and* the port accepts connections.
  // Polling this is much cheaper than spawning a client probe every 300ms.
  const up = await waitFor(() => bootReady(ctx), 30000, 200);
  if (!up) {
    const tail = tailLog(ctx);
    throw new Error(
      `${ctx.engine.label} did not become ready within 30s\n` +
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
      await spawnAsync(spec.cmd, spec.args, { cwd: ctx.root });
    }
  }

  let stopped = stale.length ? false : await waitFor(async () => !(await healthy(ctx)), 15000);
  if (!stopped && pidAlive(pid)) {
    try { process.kill(pid, 'SIGTERM'); } catch {}
    stopped = await waitFor(async () => !(await healthy(ctx)) && !pidAlive(pid), 15000);
  }
  if (!stopped && pidAlive(pid)) {
    if (!quiet) warn('graceful stop timed out — sending SIGKILL');
    try { process.kill(pid, 'SIGKILL'); } catch {}
    await waitFor(() => !pidAlive(pid), 5000);
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
