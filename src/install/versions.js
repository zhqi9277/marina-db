// Published builds, filtered to the current host, and shared by all install entry points.
import { PLATFORM, OS_LABEL } from '../core/platform.js';
import { CATALOG, majorOf } from './catalog.js';
import { loadCatalog } from './overlay.js';

export async function listVersionIndexes(keys) {
  for (const key of keys) {
    if (!Object.hasOwn(CATALOG, key)) throw new Error(`unknown database "${key}"`);
  }
  const { artifacts, source, fetchedAt } = await loadCatalog();
  return keys.map((key) => {
    const versions = artifacts
      .filter((row) => row.key === key && row.os === PLATFORM && row.arch === process.arch)
      .sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }))
      .map((row) => ({ ...row, kind: 'binary', supported: true, urls: [row.url], source }));
    return { engine: key, source, fetchedAt, versions };
  });
}

export async function listVersions(key) {
  const [index] = await listVersionIndexes([key]);
  return index;
}

export function pickEntry(engineKey, versions, tag) {
  if (!tag || tag === 'latest') return versions[0] || null;
  const exact = versions.find((v) => v.version === tag);
  if (exact) return exact;
  if (majorOf(engineKey, tag) !== tag) return null;
  return versions.find((v) => v.major === tag) || null;
}

export async function resolveVersion(engine, tag) {
  const { versions, source } = await listVersions(engine.key);
  const preferred = !tag && versions.find((v) => v.major === engine.defaultMajor);
  const hit = preferred || pickEntry(engine.key, versions, tag);
  if (hit) return { ...hit, indexSource: source };

  const have = versions.slice(0, 8).map((v) => v.version).join(', ') || 'none';
  const ref = tag ? `${engine.label} ${tag}` : engine.label;
  throw new Error(`${ref} has no published build for ${OS_LABEL} ${process.arch} (available: ${have})\n` +
    `  hint: marina remote ${engine.key}`);
}
