// The hosted catalog and explicit local/test catalogs share the same format.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { env } from '../core/platform.js';
import { CATALOG, majorOf } from './catalog.js';
import { fetchJson } from './download.js';

export const DEFAULT_CATALOG_URL = 'https://raw.githubusercontent.com/zhqi9277/marina-db/engine-catalog/manifest.json';

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

export async function loadCatalog() {
  const file = env('CATALOG_FILE');
  if (file) {
    try {
      return { source: path.resolve(file), artifacts: parseCatalog(JSON.parse(fs.readFileSync(file, 'utf8'))), fetchedAt: null };
    } catch (error) {
      throw new Error(`engine catalog ${file}: ${error.message}`);
    }
  }
  const source = env('CATALOG_URL') || DEFAULT_CATALOG_URL;
  const requireSize = source === DEFAULT_CATALOG_URL;
  // Give each read of the GitHub branch its own CDN cache key. Custom catalog
  // URLs may contain signed queries, so pass them through exactly as supplied.
  const url = requireSize ? `${source}?request=${randomUUID()}` : source;
  try {
    const raw = await fetchJson(url, { headers: { 'cache-control': 'no-cache, no-store' } });
    return { source, artifacts: parseCatalog(raw, { requireSize }), fetchedAt: Date.now() };
  } catch (error) {
    throw new Error(`engine catalog ${source}: ${error.message.replace(url, source)}`);
  }
}
