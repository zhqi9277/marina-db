// Published builds, filtered to the current host, and shared by all install entry points.
import fs from 'node:fs';
import path from 'node:path';
import { PLATFORM, OS_LABEL } from '../core/platform.js';
import { CATALOG, majorOf } from './catalog.js';
import { indexDir, loadCatalog } from './overlay.js';

export async function listVersions(key, options) {
  if (!Object.hasOwn(CATALOG, key)) throw new Error(`unknown database "${key}"`);
  const { artifacts, source, fetchedAt, stale } = await loadCatalog(options);
  const versions = artifacts
    .filter((row) => row.key === key && row.os === PLATFORM && row.arch === process.arch)
    .sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }))
    .map((row) => ({ ...row, kind: 'binary', supported: true, urls: [row.url], source }));
  return { engine: key, source, fetchedAt, stale, versions };
}

export function pickEntry(engineKey, versions, tag) {
  if (!tag || tag === 'latest') return versions[0] || null;
  const exact = versions.find((v) => v.version === tag);
  if (exact) return exact;
  if (majorOf(engineKey, tag) !== tag) return null;
  return versions.find((v) => v.major === tag) || null;
}

export async function resolveVersion(engine, tag) {
  const { versions, source, stale } = await listVersions(engine.key);
  const preferred = !tag && versions.find((v) => v.major === engine.defaultMajor);
  const hit = preferred || pickEntry(engine.key, versions, tag);
  if (hit) return { ...hit, indexSource: source, stale };

  const have = versions.slice(0, 8).map((v) => v.version).join(', ') || 'none';
  const ref = tag ? `${engine.label} ${tag}` : engine.label;
  throw new Error(`${ref} has no published build for ${OS_LABEL} ${process.arch} (available: ${have})\n` +
    `  hint: marina remote ${engine.key} --refresh`);
}

/** Cache summary for `marina doctor`, without touching the network. */
export function indexCacheInfo() {
  const engines = new Set();
  let newest = 0;
  let files = 0;
  if (fs.existsSync(indexDir)) {
    for (const name of fs.readdirSync(indexDir).filter((name) => /^catalog-[a-f0-9]{64}\.json$/.test(name))) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(indexDir, name), 'utf8'));
        if (!Number.isFinite(data.fetchedAt) || !Array.isArray(data.artifacts)) continue;
        for (const row of data.artifacts) if (Object.hasOwn(CATALOG, row.key)) engines.add(row.key);
        newest = Math.max(newest, data.fetchedAt);
        files++;
      } catch {
        // Ignore files removed or replaced by another process.
      }
    }
  }
  return { engines: [...engines], files, newest };
}
