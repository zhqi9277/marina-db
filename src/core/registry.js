// Engine registry + version resolution + per-version context.
import path from 'node:path';
import fs from 'node:fs';
import { dirs, engineDir, versionDir, etcDir, dataDir, logDir, runFile, mkdirp } from './paths.js';
import { discoverRoot } from '../install/archive.js';
import * as state from './state.js';
import mysql from '../engines/mysql.js';
import mariadb from '../engines/mariadb.js';
import postgres from '../engines/postgres.js';
import mongodb from '../engines/mongodb.js';
import redis from '../engines/redis.js';
import memcached from '../engines/memcached.js';

export const engines = { mysql, mariadb, postgres, mongodb, redis, memcached };
export const engineList = Object.values(engines);

export function getEngine(key) {
  const normalized = String(key || '').toLowerCase();
  if (!Object.hasOwn(engines, normalized)) {
    throw new Error(`unknown database "${key}" (known: ${Object.keys(engines).join(', ')})`);
  }
  return engines[normalized];
}

/** "mysql@8.4" -> { engine, tag: "8.4" } */
export function parseRef(input) {
  if (!input) throw new Error('missing database name');
  const [key, ...rest] = String(input).split('@');
  return { engine: getEngine(key), tag: rest.join('@') || null };
}

const CONF_NAMES = {
  mysql: 'my.cnf',
  mariadb: 'my.cnf',
  redis: 'redis.conf',
  mongodb: 'mongod.conf',
  memcached: 'memcached.conf',
};

/**
 * Real version directories only. `current` is a link on POSIX but becomes a
 * real directory when linkDir falls back to cpSync on Windows, and staging
 * dirs are dot-prefixed; neither may be mistaken for an installed version.
 */
function versionDirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name !== 'current' && !e.name.startsWith('.'))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

export function installedVersions(engine) {
  const base = path.join(dirs.engines, engine.key);
  const rows = [];
  for (const major of versionDirs(base)) {
    for (const version of versionDirs(path.join(base, major))) {
      if (fs.existsSync(pendingInstallFile(engine, major, version))) continue;
      rows.push({ major, version, dir: path.join(base, major, version) });
    }
  }
  return rows.sort((a, b) =>
    a.major.localeCompare(b.major, undefined, { numeric: true }) ||
    a.version.localeCompare(b.version, undefined, { numeric: true }),
  );
}

export function isInstalled(engine, major, version) {
  return fs.existsSync(versionDir(engine.key, major, version)) && !fs.existsSync(pendingInstallFile(engine, major, version));
}

export function pendingInstallFile(engine, major, version) {
  return path.join(engineDir(engine.key, major), `.pending-${version}`);
}

export function majorPick(engine, major, rows = installedVersions(engine)) {
  const sameMajor = rows.filter((row) => row.major === major);
  const selected = state.selectedVersion(engine.key, major) || state.getActive(engine.key);
  return sameMajor.find((row) => row.version === selected) || sameMajor.at(-1) || null;
}

/** Choose a version for a tag: exact ("8.4.11"), major ("8.4"), or active/latest. */
export function pickVersion(engine, tag) {
  const rows = installedVersions(engine);
  if (!rows.length) return null;
  if (!tag) {
    const active = state.getActive(engine.key);
    if (active) {
      const hit = rows.find((r) => r.version === active);
      if (hit) return hit;
    }
    return rows[rows.length - 1];
  }
  const exact = rows.find((r) => r.version === tag);
  if (exact) return exact;
  const sameMajor = majorPick(engine, tag, rows);
  if (sameMajor) return sameMajor;
  const prefix = rows.filter((r) => r.version.startsWith(`${tag}.`));
  if (prefix.length) return prefix[prefix.length - 1];
  return null;
}

export function buildCtx(engine, { major, version, port, account = state.accountOf(engine.key, major) }) {
  const root = discoverRoot(versionDir(engine.key, major, version), engine.markers);
  const p = port ?? state.portOf(engine.key, major, engine.defaultPort);
  const confName = CONF_NAMES[engine.key];
  return {
    engine,
    key: engine.key,
    major,
    version,
    port: Number(p),
    account,
    user: account.user,
    password: account.password ?? '',
    manifestName: engine.manifestName,
    root,
    versionDir: versionDir(engine.key, major, version),
    majorDir: engineDir(engine.key, major),
    dataDir: dataDir(engine.key, major),
    etcDir: etcDir(engine.key, major),
    runDir: dirs.run,
    logDir: logDir(engine.key),
    tmpDir: dirs.tmp,
    pidFile: runFile(engine.key, major, 'pid'),
    sockFile: runFile(engine.key, major, 'sock'),
    confFile: confName ? path.join(etcDir(engine.key, major), confName) : null,
    logFile: path.join(logDir(engine.key), `${major}.log`),
  };
}

export function resolveRef(ref, { requireInstalled = true } = {}) {
  const { engine, tag } = parseRef(ref);
  const pick = pickVersion(engine, tag);
  if (!pick) {
    if (requireInstalled) {
      const rows = installedVersions(engine);
      const have = rows.length ? rows.map((r) => r.version).join(', ') : 'none';
      throw new Error(`${engine.label} ${tag ? tag + ' ' : ''}is not installed (installed: ${have})\n  hint: marina install ${engine.key}@${tag || engine.defaultMajor}`);
    }
    return { engine, ctx: null, installed: false };
  }
  return { engine, ctx: buildCtx(engine, pick), installed: true, ...pick };
}

export function activeCtx(engine) {
  const pick = pickVersion(engine, null);
  if (!pick) return null;
  return buildCtx(engine, pick);
}

export function instanceContexts(engine) {
  const rows = installedVersions(engine);
  const majors = new Set(rows.map((row) => row.major));
  return [...majors].map((major) => buildCtx(engine, majorPick(engine, major, rows)));
}

export function ensureVersionDirs(engine, major) {
  mkdirp(engineDir(engine.key, major));
  mkdirp(etcDir(engine.key, major));
  mkdirp(dataDir(engine.key, major));
  mkdirp(logDir(engine.key));
}
