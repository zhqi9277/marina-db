// Version index: remote query + on-disk cache + resolution.
//
// The cache only stores the *result* of a remote query (runtime/cache/index/).
// It is not a shipped version list and can be deleted at any time.
import fs from 'node:fs';
import path from 'node:path';
import { dirs, mkdirp } from './paths.js';
import { PLATFORM, OS_LABEL } from './platform.js';
import { refreshIndex, mysqlUpstreamCandidates } from './indexing.js';
import { CATALOG, majorOf, platformProblem } from './catalog.js';
import { fetchText } from './download.js';

const TTL = Number(process.env.MARINA_INDEX_TTL || 21600) * 1000; // 6h
const INDEX_DIR = path.join(dirs.cache, 'index');

function cacheFile(key) {
  return path.join(INDEX_DIR, `${key}.${PLATFORM}.${process.arch}.json`);
}

function readCache(key) {
  try {
    return JSON.parse(fs.readFileSync(cacheFile(key), 'utf8'));
  } catch {
    return null;
  }
}

function writeCache(key, data) {
  mkdirp(INDEX_DIR);
  const file = cacheFile(key);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data) + '\n');
  fs.renameSync(tmp, file);
}

/** Decorate raw entries with platform availability for the current host. */
function decorate(key, versions) {
  const problem = platformProblem(key, PLATFORM);
  return versions.map((v) => {
    const binaryWithoutArtifact = v.kind === 'binary' && v.platformKnown && !v.urls.length;
    return {
      ...v,
      supported: !problem && !binaryWithoutArtifact,
      reason:
        problem ||
        (binaryWithoutArtifact ? `no ${OS_LABEL} ${process.arch} build for this version` : null),
    };
  });
}

/**
 * Query (or reuse) the remote index for one engine.
 * @returns {{engine:string, source:string, fetchedAt:number, stale:boolean, versions:Array}}
 */
export async function getIndex(key, { refresh = false } = {}) {
  if (!CATALOG[key]) throw new Error(`unknown database "${key}"`);
  const cached = readCache(key);

  if (!refresh && cached && Date.now() - Number(cached.fetchedAt || 0) < TTL) {
    return { ...cached, stale: false, versions: decorate(key, cached.versions) };
  }

  try {
    const { source, versions } = await refreshIndex(key);
    const payload = { engine: key, source, fetchedAt: Date.now(), versions };
    writeCache(key, payload);
    return { ...payload, stale: false, versions: decorate(key, versions) };
  } catch (e) {
    if (cached) {
      return {
        ...cached,
        stale: true,
        error: e.message,
        versions: decorate(key, cached.versions),
      };
    }
    throw e;
  }
}

export async function listVersions(key, opts) {
  const index = await getIndex(key, opts);
  return index;
}

/**
 * Pure selection logic (exported for tests):
 * full version wins; otherwise the newest entry inside the major line.
 */
export function pickEntry(engineKey, versions, tag) {
  if (!tag) return versions[0] || null;
  const exact = versions.find((v) => v.version === tag);
  if (exact) return exact;
  const major = majorOf(engineKey, tag);
  return versions.find((v) => v.major === major || v.major === tag) || null;
}

/** Find a version by full version, major line, or "latest". */
export async function resolveVersion(engine, tag) {
  const index = await getIndex(engine.key);
  const versions = index.versions;
  if (!versions.length) throw new Error(`${engine.label}: the remote index is empty`);

  const supported = versions.filter((v) => v.supported);
  const pool = supported.length ? supported : versions;

  const hit = pickEntry(engine.key, pool, tag) || (tag ? pickEntry(engine.key, versions, tag) : null);
  if (hit) return { ...hit, indexSource: index.source, stale: index.stale };

  const have = versions.slice(0, 8).map((v) => v.version).join(', ');
  throw new Error(
    `${engine.label} ${tag} is not in the remote index (newest: ${have})\n` +
      `  hint: marina remote ${engine.key} --refresh`,
  );
}

async function headOk(url, timeout = 12000) {
  try {
    const res = await fetch(url, {
      method: 'HEAD',
      redirect: 'follow',
      signal: AbortSignal.timeout(timeout),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function loadChecksum(entry, url) {
  if (entry.sha256) return entry.sha256;
  try {
    if (entry.sha256Url) {
      const text = await fetchText(entry.sha256Url, { timeout: 15000 });
      const m = text.match(/\b([a-f0-9]{64})\b/i);
      return m ? m[1].toLowerCase() : null;
    }
    if (entry.sha256File) {
      const text = await fetchText(entry.sha256File, { timeout: 15000 });
      const base = path.basename(new URL(url).pathname);
      for (const line of text.split('\n')) {
        const m = line.match(/^([a-f0-9]{64})\s+\*?(.+)$/i);
        if (m && m[2].trim() === base) return m[1].toLowerCase();
      }
    }
  } catch {
    /* checksum is best-effort */
  }
  return null;
}

/**
 * Pick a downloadable artifact for the current platform.
 * @returns {Promise<{url:string, sha256:string|null, tried:string[]}>}
 */
export async function resolveArtifact(entry, { engine = '' } = {}) {
  let urls = [...(entry.urls || [])];
  if (!urls.length && engine === 'mysql') urls = mysqlUpstreamCandidates(entry.version);
  if (!urls.length) {
    throw new Error(
      `no ${OS_LABEL} artifact is known for ${entry.version}\n` +
        `  hint: marina remote ${engine} --refresh   (or install another version)`,
    );
  }
  const tried = [];
  for (const url of urls) {
    tried.push(url);
    if (await headOk(url)) {
      return { url, sha256: await loadChecksum(entry, url), tried };
    }
  }
  throw new Error(`none of the artifact URLs answered:\n  ${tried.join('\n  ')}`);
}

/** Summary for `marina doctor` — reads the cache only, no network. */
export function indexCacheInfo() {
  try {
    const files = fs.readdirSync(INDEX_DIR).filter((f) => f.endsWith('.json'));
    let newest = 0;
    const engines = new Set();
    for (const f of files) {
      engines.add(f.split('.')[0]);
      try {
        const j = JSON.parse(fs.readFileSync(path.join(INDEX_DIR, f), 'utf8'));
        newest = Math.max(newest, Number(j.fetchedAt || 0));
      } catch {}
    }
    return { engines: [...engines], files: files.length, newest };
  } catch {
    return { engines: [], files: 0, newest: 0 };
  }
}

export const _internal = { readCache, writeCache, cacheFile, decorate, majorOf };
