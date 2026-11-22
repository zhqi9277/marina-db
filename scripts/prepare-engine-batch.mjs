// Lock the upstream archives for a particular historical version before CI
// builds them. Each emitted target still has to pass the release smoke job.
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { CATALOG } from '../src/install/catalog.js';
import { targets } from './engine-matrix.mjs';
import { extraBuildInputs, qdrantAssets, qdrantLicense } from './engine-sources.mjs';

const targetId = ({ os, arch }) => os + '-' + arch;
const shaPattern = /\b([a-f0-9]{64})\b/i;

async function request(url, timeout = 30000, method = 'GET') {
  const result = await fetch(url, { method, signal: AbortSignal.timeout(timeout) });
  if (result.status === 404 || result.status === 410) {
    await result.body?.cancel();
    return null;
  }
  if (!result.ok) throw new Error('HTTP ' + result.status + ' from ' + url);
  if (!result.url.startsWith('https:')) throw new Error('insecure upstream redirect: ' + result.url);
  return result;
}

// Use published SHA-256 when available. Otherwise lock the complete versioned
// artifact fetched over HTTPS. The build verifies the lock before extraction.
async function pin(url, { sha256, shaUrl } = {}) {
  if (!url.startsWith('https:')) throw new Error('upstream archive requires HTTPS: ' + url);
  if (sha256?.match(shaPattern)) return { url, sha256: sha256.toLowerCase() };
  if (shaUrl) {
    const checksum = await request(shaUrl);
    if (checksum) {
      const hash = (await checksum.text()).match(shaPattern)?.[1];
      if (!hash) throw new Error('invalid checksum from ' + shaUrl);
      return { url, sha256: hash.toLowerCase() };
    }
  }
  const archive = await request(url, 600000);
  if (!archive) return null;
  const digest = createHash('sha256');
  let size = 0;
  for await (const chunk of archive.body) {
    digest.update(chunk);
    size += chunk.length;
  }
  const expectedSize = Number(archive.headers.get('content-length'));
  if (!size || (expectedSize && size !== expectedSize)) throw new Error('incomplete archive: ' + url);
  return { url, sha256: digest.digest('hex'), size };
}

const once = new Map();
function memo(key, read) {
  if (!once.has(key)) once.set(key, read().catch((error) => {
    once.delete(key);
    throw error;
  }));
  return once.get(key);
}

async function postgresInput(version, os) {
  if (os === 'win32') {
    const binary = await pin('https://get.enterprisedb.com/postgresql/postgresql-' + version + '-1-windows-x64-binaries.zip');
    return binary && { binary };
  }
  const source = 'https://ftp.postgresql.org/pub/source/v' + version + '/postgresql-' + version + '.tar.gz';
  const checked = await memo(source, () => pin(source, { shaUrl: source + '.sha256' }));
  return checked && { source: checked, sourceCode: [source] };
}

async function redisInput(version, os) {
  const source = 'https://download.redis.io/releases/redis-' + version + '.tar.gz';
  if (os === 'win32') {
    const api = await request('https://api.github.com/repos/redis-windows/redis-windows/releases/tags/' + version);
    const release = await api?.json();
    const asset = release?.assets.find((item) => item.name === 'Redis-' + version + '-Windows-x64-cygwin.zip');
    if (!asset) return null;
    const binary = await pin(asset.browser_download_url, { sha256: asset.digest?.match(shaPattern)?.[1] });
    return binary && { binary, sourceCode: [source, release.html_url, 'https://cygwin.com/licensing.html'] };
  }
  const checked = await memo(source, async () => {
    const index = await memo('redis-hashes', async () =>
      (await (await request('https://raw.githubusercontent.com/redis/redis-hashes/master/README')).text()).split('\n'));
    const line = index.find((text) =>
      text.startsWith('hash redis-' + version + '.tar.gz sha256 '));
    return pin(source, { sha256: line?.match(shaPattern)?.[1] });
  });
  return checked && { source: checked, sourceCode: [source] };
}

async function memcachedInput(version, os) {
  if (os === 'win32') {
    // The Windows port's tag differs from the upstream source version.
    if (version !== '1.6.8') return null;
    const release = 'https://github.com/jefyt/memcached-windows/releases/download/1.6.8_mingw_libressl/';
    const binary = await pin(release + 'memcached-1.6.8-win64-mingw.zip');
    return binary && { binary, sourceCode: ['https://github.com/jefyt/memcached-windows/tree/1.6.8_mingw_libressl'] };
  }
  const url = 'https://memcached.org/files/memcached-' + version + '.tar.gz';
  const source = await memo(url, () => pin(url));
  return source && { source, sourceCode: [url] };
}

async function mariaInput(version, os, arch) {
  const base = 'https://downloads.mariadb.org/rest-api/mariadb/' + version + '/';
  const files = await memo(base, async () => {
    const json = await (await request(base))?.json();
    return (json?.release_data ?? json?.releases)?.[version]?.files ?? [];
  });
  const sourceFile = files.find((item) => item.file_name === 'mariadb-' + version + '.tar.gz');
  const selected = files.find((item) => {
    if (os === 'win32') return item.file_name === 'mariadb-' + version + '-winx64.zip';
    if (os !== 'linux') return false;
    const cpu = arch === 'x64' ? 'x86_64' : 'aarch64';
    return item.file_name === 'mariadb-' + version + '-linux-systemd-' + cpu + '.tar.gz';
  });
  const file = selected ?? (os === 'win32' ? undefined : sourceFile);
  if (!file) return null;
  const metaUrl = (item) => new URL(encodeURIComponent(item.file_name), base).href;
  const archive = await memo(file.file_name, () => pin(metaUrl(file), { sha256: file.checksum?.sha256sum }));
  return archive && {
    [selected ? 'binary' : 'source']: archive,
    sourceCode: sourceFile ? [metaUrl(sourceFile)] : [],
  };
}

async function mongoInput(version, os, arch) {
  const url = 'https://downloads.mongodb.org/full.json';
  const releases = await memo(url, async () => {
    const data = await (await request(url, 180000)).json();
    return new Map(data.versions
      .filter((row) => row.production_release && !row.development_release && !row.release_candidate)
      .map((row) => [row.version, row.downloads?.filter((item) => item.edition === 'base' && item.archive?.url) ?? []]));
  });
  const downloads = releases.get(version);
  if (!downloads) return null;
  const platform = { darwin: ['macos', 'osx'], linux: ['ubuntu2204', 'ubuntu2004', 'debian12'], win32: ['windows'] }[os];
  const cpu = arch === 'arm64' ? ['arm64', 'aarch64'] : ['x86_64', 'x64'];
  const available = platform.map((target) => downloads.find((row) =>
    row.target === target && cpu.includes(row.arch) && /\.(?:tgz|zip|tar\.gz)$/.test(row.archive.url))).find(Boolean);
  // Ubuntu release archives may be listed under a different distro label.
  // The canonical filename is also checked for the matching Linux architecture.
  const suffix = arch === 'arm64' ? 'aarch64' : 'x86_64';
  const fallback = os === 'linux' ? 'https://fastdl.mongodb.org/linux/mongodb-linux-' + suffix + '-ubuntu2204-' + version + '.tgz' : null;
  const source = available?.archive.url ?? fallback;
  if (!source) return null;
  const binary = await pin(source, { sha256: available?.archive.sha256, shaUrl: source + '.sha256' });
  return binary && { binary, sourceCode: ['https://github.com/mongodb/mongo/tree/r' + version, 'https://github.com/mongodb-js/mongosh/tree/v2.14.2'] };
}

async function mysqlInput(version, os, arch) {
  const major = version.split('.').slice(0, 2).join('.');
  const archive = 'https://cdn.mysql.com/archives/mysql-' + major + '/';
  const current = 'https://cdn.mysql.com/Downloads/MySQL-' + major + '/';
  const prefix = 'mysql-' + version;
  const cpu = arch === 'x64' ? 'x86_64' : 'aarch64';
  let suffixes;
  if (os === 'win32') {
    suffixes = ['winx64.zip'];
  } else if (os === 'darwin') {
    const macCpu = arch === 'x64' ? 'x86_64' : 'arm64';
    const names = arch === 'x64'
      ? ['macos15', 'macos14', 'macos13', 'macos12', 'macos11', 'osx10.15', 'macos10.15', 'macos10.14',
        'macos10.13', 'macos10.12', 'osx10.13', 'osx10.12', 'osx10.11', 'osx10.10', 'osx10.9', 'osx10.8', 'osx10.7']
      : ['macos15', 'macos14', 'macos13', 'macos12', 'macos11'];
    suffixes = names.map((name) => name + '-' + macCpu + '.tar.gz');
  } else {
    const libc = ['2.28', '2.17', '2.12'];
    const stems = libc.map((abi) => 'linux-glibc' + abi + '-' + cpu);
    // Prefer the newer compatible build even if it lacks a minimal archive.
    // Older ARM64 builds can link optional modules to OpenSSL 1.0.
    suffixes = [...stems.flatMap((stem) => [stem + '-minimal.tar.xz', stem + '.tar.xz', stem + '.tar.gz']),
      'linux-' + cpu + '.tar.gz'];
  }
  const official = suffixes.flatMap((name) => [archive, current].map((url) => url + prefix + '-' + name));
  const sourceCode = ['https://github.com/mysql/mysql-server/tree/mysql-' + version];
  const additional = [];
  if (version === '8.0.37' && os === 'linux' && arch === 'arm64') {
    const oracle = 'https://yum.oracle.com/repo/OracleLinux/OL8/baseos/latest/';
    // The glibc 2.28 LDAP client modules require the OpenSSL 1.1 ABI.
    additional.push({
      url: oracle + 'aarch64/getPackage/openssl-libs-1.1.1k-18.el8_6.aarch64.rpm',
      sha256: '85a712b51cd5645b5019ecb7486fa1e438c8d4365172a8c39074f9e0c77208b2',
    });
    sourceCode.push(oracle + 'x86_64/getPackageSource/openssl-1.1.1k-18.el8_6.src.rpm');
  }
  let lookupError;
  // Probe in small groups to preserve the preferred archive order while
  // avoiding a full download for each candidate filename.
  for (let i = 0; i < official.length; i += 6) {
    const group = official.slice(i, i + 6);
    const results = await Promise.allSettled(group.map((url) => request(url, 12000, 'HEAD')));
    for (const [index, result] of results.entries()) {
      if (result.status === 'rejected') {
        lookupError ??= result.reason;
        continue;
      }
      // Oracle serves some valid XZ archives as text/plain.
      if (result.value && !/^text\/html\b/i.test(result.value.headers.get('content-type') ?? '')) {
        const binary = await pin(group[index]);
        if (binary) return { binary, sourceCode, additional };
      }
    }
  }
  const base = 'https://repo.huaweicloud.com/mysql/Downloads/MySQL-' + major + '/';
  const files = await memo(base, async () => {
    const response = await request(base);
    const html = await response?.text() ?? '';
    return [...new Set([...html.matchAll(/href=["']([^"'/]+)["']/g)].map((row) => row[1]))];
  });
  const compatible = files.filter((file) => {
    if (!file.startsWith('mysql-' + version + '-')) return false;
    if (os === 'win32') return file.endsWith('-winx64.zip');
    if (os === 'darwin') {
      const cpu = arch === 'x64' ? 'x86_64' : 'arm64';
      return new RegExp('-macos(?:1[1-5]|10\\.\\d+)-' + cpu + '\\.tar\\.gz$').test(file);
    }
    const cpu = arch === 'x64' ? 'x86_64' : 'aarch64';
    return new RegExp('-linux-glibc2\\.(?:1[2-9]|2[0-9]|3[0-5])-' + cpu + '(?:-minimal)?\\.tar\\.xz$').test(file);
  });
  const pkg = compatible.find((file) => file.endsWith('-minimal.tar.xz')) ?? compatible.at(-1);
  if (!pkg) {
    if (lookupError) throw lookupError;
    return null;
  }
  const binary = await pin(base + pkg);
  return binary && { binary, sourceCode, additional };
}

async function qdrantInput(version, os, arch) {
  const base = 'https://github.com/qdrant/qdrant';
  const release = await memo('qdrant-' + version, async () =>
    (await request('https://api.github.com/repos/qdrant/qdrant/releases/tags/v' + version))?.json());
  if (!release || release.prerelease || release.draft) return null;
  const asset = release.assets.find(({ name }) => name === qdrantAssets[os + '-' + arch]);
  if (!asset) return null;
  const binary = await pin(asset.browser_download_url, { sha256: asset.digest });
  const license = await memo('qdrant-license-' + version, () => pin(qdrantLicense(version)));
  if (!license) throw new Error('missing Qdrant license for ' + version);
  return binary && { binary, additional: [license], sourceCode: [base + '/tree/v' + version] };
}

const resolvers = {
  mysql: mysqlInput, mariadb: mariaInput, postgres: postgresInput,
  mongodb: mongoInput, redis: redisInput, memcached: memcachedInput,
  qdrant: qdrantInput,
};

export async function prepareBatch(engine, version, requested = []) {
  if (!Object.hasOwn(CATALOG, engine) || !/^\d+\.\d+(?:\.\d+)?$/.test(version || '')) {
    throw new Error('usage: prepare-engine-batch.mjs <engine> <version> [os-arch ...]');
  }
  const platforms = targets.filter((row) => !requested.length || requested.includes(targetId(row)));
  if (requested.some((id) => !platforms.some((row) => targetId(row) === id))) throw new Error('unknown build target');
  const results = await Promise.allSettled(platforms.map(async ({ os, arch }) => {
    const inputs = await resolvers[engine](version, os, arch);
    if (!inputs) return null;
    const additional = [...(inputs.additional ?? []), ...extraBuildInputs(engine, os, arch)];
    return { engine, version, os, arch, inputs: { ...inputs, additional } };
  }));
  const rows = [];
  const omitted = [];
  for (const [i, result] of results.entries()) {
    if (result.status === 'fulfilled' && result.value) rows.push(result.value);
    else omitted.push({
      target: targetId(platforms[i]),
      state: result.status === 'rejected' ? 'lookup-error' : 'archive-unavailable',
      reason: result.reason?.message ?? 'no compatible upstream archive found',
    });
  }
  return { rows, omitted };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [engine, version, ...requested] = process.argv.slice(2);
  const { rows, omitted } = await prepareBatch(engine, version, requested);
  for (const item of omitted) console.error(item.target + ' ' + item.reason);
  if (!rows.length) process.exitCode = 1;
  console.log(JSON.stringify(rows, null, 2));
}
