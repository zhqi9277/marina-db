// Inventory from the projects' own release indexes. A version is available to
// Marina only when its platform build also appears in the published catalog.
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { DEFAULT_CATALOG_URL, parseCatalog } from '../src/install/overlay.js';
import { targets } from './engine-matrix.mjs';

const exec = promisify(execFile);
const numericVersion = /^\d+\.\d+(?:\.\d+)?$/;
const unique = (values) => [...new Set(values)].sort((a, b) => b.localeCompare(a, 'en', { numeric: true }));

export const historySources = {
  mysql: 'https://downloads.mysql.com/archives/community/',
  mariadb: 'https://mariadb.org/mariadb/all-releases/',
  postgres: 'https://ftp.postgresql.org/pub/source/',
  mongodb: 'https://downloads.mongodb.org/full.json',
  redis: 'https://download.redis.io/releases/',
  memcached: 'https://github.com/memcached/memcached.git',
};

async function readText(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(180000) });
  if (!response.ok) throw new Error('HTTP ' + response.status + ' from ' + url);
  return response.text();
}

export function parseVersions(engine, content) {
  switch (engine) {
    case 'mysql': {
      const select = content.match(/<select\b[^>]*\bname=["']version["'][^>]*>([\s\S]*?)<\/select>/i)?.[1] ?? '';
      return unique([...select.matchAll(/<option\b[^>]*\bvalue=["'](\d+\.\d+\.\d+)["']/g)].map((match) => match[1]));
    }
    case 'mariadb': {
      const rows = [...content.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((match) =>
        [...match[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((cell) => cell[1].replace(/<[^>]+>/g, '').trim()));
      return unique(rows.filter(([version, , status]) => status === 'Stable' && numericVersion.test(version))
        .map(([version]) => version));
    }
    case 'postgres':
      return unique([...content.matchAll(/href=["']v(\d+\.\d+(?:\.\d+)?)\/["']/g)].map((match) => match[1]));
    case 'mongodb': {
      const versions = JSON.parse(content).versions;
      if (!Array.isArray(versions)) throw new Error('MongoDB index has no versions');
      return unique(versions.filter((row) => row.production_release && !row.development_release &&
        !row.release_candidate && numericVersion.test(row.version)).map((row) => row.version));
    }
    case 'redis':
      return unique([...content.matchAll(/href=["']redis-([1-9]\d*\.\d+(?:\.\d+)?)\.tar\.gz["']/g)]
        .map((match) => match[1]));
    case 'memcached':
      return unique([...content.matchAll(/\brefs\/tags\/(?:release-|v)?(\d+\.\d+\.\d+)\s*$/gm)].map((match) => match[1]));
    default: throw new Error('unknown engine history: ' + engine);
  }
}

export function summarizeHistory(upstream, published) {
  const available = new Map();
  for (const row of parseCatalog(published, { requireSize: true })) {
    const key = row.key + '@' + row.version;
    const list = available.get(key) ?? [];
    list.push(row.os + '-' + row.arch);
    available.set(key, list);
  }
  return Object.fromEntries(Object.entries(upstream).map(([engine, versions]) => {
    const records = unique(versions).map((version) => {
      const publishedTargets = available.get(engine + '@' + version) ?? [];
      const pendingTargets = targets.map(({ os, arch }) => os + '-' + arch)
        .filter((target) => !publishedTargets.includes(target));
      return { version, publishedTargets, pendingTargets };
    });
    return [engine, { source: historySources[engine], versions: records }];
  }));
}

async function readIndex(engine, url) {
  const contents = engine === 'memcached'
    ? (await exec('git', ['ls-remote', '--refs', '--tags', url], { timeout: 120000, maxBuffer: 5 * 1024 ** 2 })).stdout
    : await readText(url);
  const versions = parseVersions(engine, contents);
  if (!versions.length) throw new Error('no versions found for ' + engine + ' at ' + url);
  return [engine, versions];
}

async function run(engine) {
  if (engine && !Object.hasOwn(historySources, engine)) throw new Error('unknown engine: ' + engine);
  const sources = Object.entries(historySources).filter(([key]) => !engine || key === engine);
  // Await all sources, so diagnostics name every unavailable upstream.
  const results = await Promise.allSettled([
    readText(DEFAULT_CATALOG_URL).then(JSON.parse),
    ...sources.map(([key, url]) => readIndex(key, url)),
  ]);
  const [published, ...rows] = results;
  if (published.status === 'rejected') throw published.reason;
  const snapshot = JSON.parse(readFileSync(new URL('./engine-history.snapshot.json', import.meta.url), 'utf8'));
  const reported = rows.map((result, i) => {
    if (result.status === 'fulfilled') return result.value;
    const [key] = sources[i];
    const versions = snapshot.versions[key];
    if (!Array.isArray(versions) || !versions.length || !versions.every((value) => numericVersion.test(value))) {
      throw result.reason;
    }
    console.error(key + ' uses snapshot ' + snapshot.date + ': ' + result.reason.message);
    return [key, versions];
  });
  const history = summarizeHistory(Object.fromEntries(reported), published.value);
  for (const [i, result] of rows.entries()) {
    if (result.status === 'rejected') history[sources[i][0]].snapshotDate = snapshot.date;
  }
  console.log(JSON.stringify({ schema: 1, history }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await run(process.argv[2]);
}
