// Persistent user state: active version per engine, ports, settings.
import fs from 'node:fs';
import path from 'node:path';
import { dirs } from './paths.js';

const FILE = path.join(dirs.root, 'state.json');
const LOCK = path.join(dirs.root, 'state.lock');
const DEFAULTS = { version: 1, active: {}, ports: {}, settings: { mysqlRootPassword: 'root', accounts: {}, autostart: [] } };

function objectOf(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

// ------------------------------------------------------------------ locking --
// Every read-modify-write goes through mutate(): two CLI/TUI processes updating
// different keys would otherwise overwrite each other with a stale snapshot.

function envNumber(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

// read on every acquire — tests (and users) can tune them per process
function lockTimeout() {
  return envNumber('MARINA_STATE_LOCK_TIMEOUT', 2000);
}

function lockStale() {
  return envNumber('MARINA_STATE_LOCK_STALE', 10000);
}

/** synchronous sleep without busy-spinning (no async in the state API) */
function sleepSync(ms) {
  const flag = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(flag, 0, 0, ms);
}

function ownerAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/** mkdir is atomic: acquire `<root>/state.lock`, reclaim stale locks, return release */
function acquireLock() {
  const timeout = lockTimeout();
  const stale = lockStale();
  const started = Date.now();
  fs.mkdirSync(dirs.root, { recursive: true });
  for (;;) {
    try {
      fs.mkdirSync(LOCK);
      try { fs.writeFileSync(path.join(LOCK, 'pid'), String(process.pid)); } catch {}
      return () => {
        try { fs.rmSync(LOCK, { recursive: true, force: true }); } catch {}
      };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }

    let stat = null;
    try {
      stat = fs.statSync(LOCK);
    } catch {
      continue; // released between mkdir and stat — try again immediately
    }
    let owner = null;
    try {
      owner = Number(fs.readFileSync(path.join(LOCK, 'pid'), 'utf8').trim());
    } catch {}
    const age = Date.now() - stat.mtimeMs;
    const hasOwner = Number.isFinite(owner) && owner > 0;
    const dead = hasOwner && !ownerAlive(owner);
    // A pid file is written right after mkdir; if it is still missing after a
    // grace period the creator died in between. An aged lock "owned" by this
    // very pid is a leftover from a previous run (pids get reused) — but a fresh
    // one is treated as held so a nested/second writer still times out.
    const ownerless = !hasOwner && age > 200;
    const ownLeftover = hasOwner && owner === process.pid && age > 200;
    if (dead || ownerless || ownLeftover || age > stale) {
      // re-check before removing so a lock that was just recreated is not stolen
      try {
        const now = fs.statSync(LOCK);
        if (now.mtimeMs !== stat.mtimeMs) continue;
        fs.rmSync(LOCK, { recursive: true, force: true });
      } catch {}
      continue;
    }
    if (Date.now() - started >= timeout) {
      const held = Number.isFinite(owner) && owner > 0 ? ` (held by pid ${owner})` : '';
      throw new Error(`state.lock timeout after ${timeout}ms${held} — remove ${LOCK} if marina crashed`);
    }
    sleepSync(5);
  }
}

/**
 * Locked read-modify-write of state.json. `fn` mutates the loaded object (or
 * returns a replacement) and the result is written atomically. Returns the
 * saved state.
 */
export function mutate(fn) {
  const release = acquireLock();
  try {
    const current = load();
    const next = fn(current);
    return save(next === undefined ? current : next);
  } finally {
    release();
  }
}

export const ACCOUNT_DEFAULTS = {
  mysql: { user: 'root', password: null },
  mariadb: { user: 'root', password: null },
  postgres: { user: 'postgres', password: null },
  mongodb: { user: null, password: null },
  redis: { user: null, password: null },
  memcached: { user: null, password: null },
};

/** pure resolver, also used by tests */
export function resolveAccount(settings = {}, key) {
  const base = ACCOUNT_DEFAULTS[key] || { user: null, password: null };
  const saved = settings.accounts?.[key] || {};
  let password = saved.password !== undefined ? saved.password : base.password;
  if (password === null && (key === 'mysql' || key === 'mariadb')) {
    password = settings.mysqlRootPassword ?? 'root';
  }
  return { user: saved.user !== undefined ? saved.user : base.user, password };
}

export function load() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return structuredClone(DEFAULTS);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return structuredClone(DEFAULTS);
  const settings = objectOf(raw.settings);
  // a hand-edited or half-written file can carry null/wrong-typed sections;
  // normalize them so getActive()/portOf()/autostartList() never throw
  const active = {};
  for (const [key, value] of Object.entries(objectOf(raw.active))) {
    if (typeof value === 'string' && value) active[key] = value;
  }
  const ports = {};
  for (const [key, value] of Object.entries(objectOf(raw.ports))) {
    if (Number.isInteger(value) && value >= 1 && value <= 65535) ports[key] = value;
  }
  return {
    ...DEFAULTS,
    ...raw,
    active,
    ports,
    settings: {
      ...DEFAULTS.settings,
      ...settings,
      accounts: objectOf(settings.accounts),
      autostart: Array.isArray(settings.autostart) ? settings.autostart.filter((id) => typeof id === 'string') : [],
    },
  };
}

export function save(state) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.${process.pid}.tmp`;
  // credentials are stored in clear text — keep the file private
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, FILE);
  return state;
}

export function setActive(key, version) {
  return mutate((s) => {
    if (version) s.active[key] = version;
    else delete s.active[key];
  });
}

export function accountOf(key) {
  return resolveAccount(load().settings, key);
}

export function setAccount(key, patch) {
  return mutate((s) => {
    const next = { ...resolveAccount(s.settings, key), ...patch };
    s.settings.accounts = { ...(s.settings.accounts || {}), [key]: next };
    if (key === 'mysql') s.settings.mysqlRootPassword = next.password;
  });
}

export function autostartList() {
  return load().settings.autostart || [];
}

export function setAutostart(ids) {
  return mutate((s) => {
    s.settings.autostart = [...new Set(ids)].sort();
  });
}

export function getActive(key) {
  return load().active[key] || null;
}

export function portOf(key, major, fallback) {
  const s = load();
  return s.ports[`${key}:${major}`] ?? fallback;
}

export function setPort(key, major, port) {
  const value = Number(port);
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error('port must be 1..65535');
  return mutate((s) => {
    s.ports[`${key}:${major}`] = value;
  });
}

export function setting(name, fallback) {
  const s = load();
  return s.settings[name] ?? fallback;
}
