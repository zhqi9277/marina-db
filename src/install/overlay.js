// The hosted catalog and explicit local/test catalogs share the same format.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { env } from '../core/platform.js';
import { dirs } from '../core/paths.js';
import { CATALOG, majorOf } from './catalog.js';
import { fetchJson } from './download.js';

export const DEFAULT_CATALOG_URL = 'https://raw.githubusercontent.com/zhqi9277/marina-db/engine-catalog/manifest.json';
export const indexDir = path.join(dirs.cache, 'index');

export function normalizeOs(os) {
  const value = String(os || '').toLowerCase();
  if (['macos', 'mac', 'osx'].includes(value)) return 'darwin';
  if (['windows', 'win'].includes(value)) return 'win32';
  return value;
}

export function normalizeArch(arch) {
  if (arch === 'aarch64') return 'arm64';
  if (arch === 'x86_64') return 'x64';
  return arch;
}

export function parseCatalog(raw, { requireSize = false } = {}) {
  const entries = Array.isArray(raw) ? raw : raw?.artifacts ?? raw?.packages;
  if (!Array.isArray(entries) || (raw.schema != null && raw.schema !== 1)) {
    throw new Error('invalid engine catalog schema');
  }
  const seen = new Set();
  return entries.flatMap((entry) => {
    const key = Object.keys(CATALOG).find((key) => key === entry?.name || CATALOG[key].manifestName === entry?.name);
    if (!key) return []; // Allow newer catalogs to introduce engines older CLIs do not know.
    const { version, url, size, sha256 } = entry;
    const os = normalizeOs(entry.os);
    const arch = normalizeArch(entry.arch);
    const major = majorOf(key, version);
    if (typeof version !== 'string' || !/^\d+(?:\.\d+){1,2}$/.test(version) ||
        typeof url !== 'string' || !/^https?:\/\//i.test(url) ||
        typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(sha256) ||
        !os || !arch || ((size != null || requireSize) && (!Number.isSafeInteger(size) || size <= 0))) {
      throw new Error(`invalid catalog artifact for ${key} ${version} (${os}/${arch})`);
    }
    const id = `${key}/${version}/${os}/${arch}`;
    if (seen.has(id)) throw new Error(`duplicate catalog artifact ${id}`);
    seen.add(id);
    return [{ ...entry, name: CATALOG[key].manifestName, key, version, major, os, arch, sha256: sha256.toLowerCase() }];
  });
}

const requests = new Map();

export async function loadCatalog({ refresh = false } = {}) {
  const file = env('CATALOG_FILE');
  if (file) {
    try {
      return { source: path.resolve(file), artifacts: parseCatalog(JSON.parse(fs.readFileSync(file, 'utf8'))), fetchedAt: null, stale: false };
    } catch (error) {
      throw new Error(`engine catalog ${file}: ${error.message}`);
    }
  }
  const url = env('CATALOG_URL') || DEFAULT_CATALOG_URL;
  const existing = requests.get(url);
  if (existing && (existing.refresh || !refresh)) return existing.promise;
  const promise = loadRemoteCatalog(url, refresh).finally(() => {
    if (requests.get(url)?.promise === promise) requests.delete(url);
  });
  requests.set(url, { promise, refresh });
  return promise;
}

async function loadRemoteCatalog(source, refresh) {
  const requireSize = source === DEFAULT_CATALOG_URL;
  const name = crypto.createHash('sha256').update(source).digest('hex');
  const file = path.join(indexDir, `catalog-${name}.json`);
  const ttl = Number(env('INDEX_TTL', 21600)) * 1000;
  let cached;
  try {
    const { fetchedAt, artifacts } = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Number.isFinite(fetchedAt)) cached = { source, fetchedAt, artifacts: parseCatalog(artifacts, { requireSize }) };
  } catch {
    // Missing, obsolete or invalid cache entries are refreshed from the same source.
  }
  if (!refresh && cached && Date.now() - cached.fetchedAt < ttl) return { ...cached, stale: false };

  let artifacts;
  try {
    artifacts = parseCatalog(await fetchJson(source), { requireSize });
  } catch (error) {
    if (!refresh && cached) return { ...cached, stale: true, error: error.message };
    throw new Error(`engine catalog ${source}: ${error.message}`);
  }
  const fetchedAt = Date.now();
  fs.mkdirSync(indexDir, { recursive: true });
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify({ fetchedAt, artifacts }));
    fs.renameSync(temp, file);
  } finally {
    fs.rmSync(temp, { force: true });
  }
  return { source, artifacts, fetchedAt, stale: false };
}
