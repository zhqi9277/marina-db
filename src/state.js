// Persistent user state: active version per engine, ports, settings.
import fs from 'node:fs';
import path from 'node:path';
import { dirs } from './paths.js';

const FILE = path.join(dirs.root, 'state.json');
const DEFAULTS = { version: 1, active: {}, ports: {}, settings: { mysqlRootPassword: 'root', accounts: {} } };

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
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return { ...DEFAULTS, ...raw, settings: { ...DEFAULTS.settings, ...(raw.settings || {}) } };
  } catch {
    return structuredClone(DEFAULTS);
  }
}

export function save(state) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
  fs.renameSync(tmp, FILE);
  return state;
}

export function setActive(key, version) {
  const s = load();
  if (version) s.active[key] = version;
  else delete s.active[key];
  return save(s);
}

export function accountOf(key) {
  return resolveAccount(load().settings, key);
}

export function setAccount(key, patch) {
  const s = load();
  const next = { ...resolveAccount(s.settings, key), ...patch };
  s.settings.accounts = { ...(s.settings.accounts || {}), [key]: next };
  if (key === 'mysql') s.settings.mysqlRootPassword = next.password;
  return save(s);
}

export function getActive(key) {
  return load().active[key] || null;
}

export function portOf(key, major, fallback) {
  const s = load();
  return s.ports[`${key}:${major}`] ?? fallback;
}

export function setPort(key, major, port) {
  const s = load();
  s.ports[`${key}:${major}`] = Number(port);
  return save(s);
}

export function setting(name, fallback) {
  const s = load();
  return s.settings[name] ?? fallback;
}
