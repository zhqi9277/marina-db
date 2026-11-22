// Inventory from the projects' own release indexes. A version is available to
// Marina only when its platform build also appears in the published catalog.
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { DEFAULT_CATALOG_URL, parseCatalog } from '../src/install/overlay.js';
import { engineTargets } from './engine-matrix.mjs';

const exec = promisify(execFile);
const numericVersion = /^\d+\.\d+(?:\.\d+)?$/;
const unique = (values) => [...new Set(values)].sort((a, b) => b.localeCompare(a, 'en', { numeric: true }));
// The archive selector includes milestones and release candidates in these series.
// https://dev.mysql.com/doc/refman/8.0/en/faqs-general.html
const firstMysqlGa = { '8.0': 11, '5.7': 9, '5.6': 10, '5.5': 8, '5.1': 30, '5.0': 15 };

function mysqlGa(versions) {
  return unique(versions.filter((version) => {
    const [major, minor, patch] = version.split('.');
    return Number(patch) >= (firstMysqlGa[major + '.' + minor] ?? 0);
  }));
}

export const historySources = {
  mysql: 'https://github.com/mysql/mysql-server.git',
  mariadb: 'https://mariadb.org/mariadb/all-releases/',
  postgres: 'https://ftp.postgresql.org/pub/source/',
  mongodb: 'https://downloads.mongodb.org/full.json',
  redis: 'https://download.redis.io/releases/',
  memcached: 'https://github.com/memcached/memcached.git',
  qdrant: 'https://github.com/qdrant/qdrant.git',
  milvus: 'https://github.com/milvus-io/milvus.git',
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
      const archive = [...select.matchAll(/<option\b[^>]*\bvalue=["'](\d+\.\d+\.\d+)["']/g)];
      const tags = [...content.matchAll(/\brefs\/tags\/mysql-(\d+\.\d+\.\d+)$/gm)];
      return mysqlGa([...archive, ...tags].map((match) => match[1]));
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
    case 'qdrant':
      return unique([...content.matchAll(/\brefs\/tags\/v(\d+\.\d+\.\d+)$/gm)].map((match) => match[1]));
    case 'milvus':
      // The native Standalone package uses the 3.x embedded local-storage configuration.
      return unique([...content.matchAll(/\brefs\/tags\/v(3\.\d+\.\d+)$/gm)].map((match) => match[1]));
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
      const pendingTargets = engineTargets(engine).map(({ os, arch }) => os + '-' + arch)
        .filter((target) => !publishedTargets.includes(target));
      return { version, publishedTargets, pendingTargets };
    });
    return [engine, { source: historySources[engine], versions: records }];
  }));
}

async function readIndex(engine, url) {
  const contents = url.endsWith('.git')
    ? (await exec('git', ['ls-remote', '--refs', '--tags', url, ...(engine === 'mysql' ? ['refs/tags/mysql-*'] : [])],
      { timeout: 120000, maxBuffer: 5 * 1024 ** 2 })).stdout
    : await readText(url);
  const versions = parseVersions(engine, contents);
  if (!versions.length) throw new Error('no versions found for ' + engine + ' at ' + url);
  return [engine, versions];
}

export async function readLiveVersions(engine) {
  if (!Object.hasOwn(historySources, engine)) throw new Error('unknown engine: ' + engine);
  return (await readIndex(engine, historySources[engine]))[1];
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
    const [key] = sources[i];
    const versions = result.status === 'fulfilled' ? result.value[1] : snapshot.versions[key];
    if (result.status === 'rejected') {
      if (!Array.isArray(versions) || !versions.length || !versions.every((value) => numericVersion.test(value))) {
        throw result.reason;
      }
      console.error(key + ' uses snapshot ' + snapshot.date + ': ' + result.reason.message);
    }
    // Include confirmed formal releases omitted from the upstream index.
    // https://dev.mysql.com/doc/relnotes/mysql/8.0/en/
    // https://dev.mysql.com/downloads/mysql/
    if (key === 'mysql') return [key, mysqlGa([...versions, '8.0.29', '8.0.38', '8.0.46', '26.10.0'])];
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
