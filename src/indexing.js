// Remote version discovery. Nothing here is a version list: every value comes
// from a mirror directory listing or an official index at query time.
//
// Source order is mirror-first (aliyun / tencent / huawei) with the official
// upstream as the final fallback, because the Chinese mirrors do not carry
// every engine (verified 2026-10):
//   postgresql  aliyun / tencent / huawei / ftp.postgresql.org
//   redis       huawei / download.redis.io
//   mariadb     aliyun / tencent / huawei
//   memcached   huawei / memcached.org
//   mysql       aliyun + huawei directories (<= 8.0.x) + github tags (8.4+)
//   mongodb     downloads.mongodb.org full.json + fastdl
import { fetchText } from './download.js';
import { PLATFORM, arch } from './platform.js';
import { CATALOG, majorOf } from './catalog.js';

const ALIYUN = 'https://mirrors.aliyun.com';
const TENCENT = 'https://mirrors.cloud.tencent.com';
const HUAWEI = 'https://mirrors.huaweicloud.com';

// MARINA_MIRROR=huawei,aliyun  reorders the preferred index/download source.
// Only names that exist in the engine's source list have an effect.
function orderSources(sources) {
  const pref = String(process.env.MARINA_MIRROR || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!pref.length) return sources;
  const rank = (name) => {
    const i = pref.indexOf(name);
    return i < 0 ? 99 : i;
  };
  return [...sources].sort((a, b) => rank(a.name) - rank(b.name));
}

const MYSQL_ATOM = 'https://github.com/mysql/mysql-server/tags.atom';
const MONGO_FULL = 'https://downloads.mongodb.org/full.json';

// ------------------------------------------------------------------ generic --
export function parseHrefs(html) {
  const out = [];
  const re = /<a\s+[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const href = m[1];
    if (!href || href.startsWith('?') || href.startsWith('#') || /^(mailto|javascript):/.test(href)) continue;
    if (/^https?:\/\//i.test(href) && !/^https?:\/\/[^/]*(mirrors|ftp\.postgresql|download\.redis|memcached|archive\.mariadb)/i.test(href)) {
      continue; // third-party nav link
    }
    const clean = href.split('#')[0].split('?')[0];
    const dir = clean.endsWith('/');
    const name = clean.replace(/\/+$/, '').split('/').pop();
    if (!name || name === '..' || name === '.') continue;
    out.push({ href: clean, name, dir });
  }
  return out;
}

export function sortVersionsDesc(list) {
  return list.sort((a, b) => {
    const pa = String(a.version).split('.').map(Number);
    const pb = String(b.version).split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const d = (pb[i] || 0) - (pa[i] || 0);
      if (d) return d;
    }
    return 0;
  });
}

export function entryOf(key, version, source, extra = {}) {
  return {
    version,
    major: majorOf(key, version),
    kind: CATALOG[key].kind,
    source,
    urls: [],
    ...extra,
  };
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

// ------------------------------------------------------- simple index types --
export const PROFILES = {
  postgres: {
    type: 'dirs',
    sources: [
      { name: 'aliyun', base: `${ALIYUN}/postgresql/source/` },
      { name: 'tencent', base: `${TENCENT}/postgresql/source/` },
      { name: 'huawei', base: `${HUAWEI}/postgresql/source/` },
      { name: 'upstream', base: 'https://ftp.postgresql.org/pub/source/' },
    ],
    versionFrom: (name) => name.match(/^v(\d+\.\d+(?:\.\d+)?)$/)?.[1],
    artifact: (v, base) => ({
      urls: [`${base}v${v}/postgresql-${v}.tar.gz`],
      sha256Url: `${base}v${v}/postgresql-${v}.tar.gz.sha256`,
    }),
  },

  redis: {
    type: 'files',
    sources: [
      { name: 'huawei', base: `${HUAWEI}/redis/` },
      { name: 'upstream', base: 'https://download.redis.io/releases/' },
    ],
    versionFrom: (name) => name.match(/^redis-(\d+\.\d+\.\d+)\.tar\.gz$/)?.[1],
    artifact: (v, base) => ({ urls: [`${base}redis-${v}.tar.gz`] }),
  },

  memcached: {
    type: 'files',
    sources: [
      { name: 'huawei', base: `${HUAWEI}/memcached/` },
      { name: 'upstream', base: 'https://memcached.org/files/' },
    ],
    versionFrom: (name) => name.match(/^memcached-(\d+\.\d+\.\d+)\.tar\.gz$/)?.[1],
    artifact: (v, base) => ({ urls: [`${base}memcached-${v}.tar.gz`] }),
  },

  mariadb: {
    type: 'dirs',
    sources: [
      { name: 'aliyun', base: `${ALIYUN}/mariadb/` },
      { name: 'tencent', base: `${TENCENT}/mariadb/` },
      { name: 'huawei', base: `${HUAWEI}/mariadb/` },
    ],
    versionFrom: (name) => name.match(/^mariadb-(\d+\.\d+\.\d+)$/)?.[1],
    artifact: (v, base) => ({
      urls: [`${base}mariadb-${v}/source/mariadb-${v}.tar.gz`],
      sha256File: `${base}mariadb-${v}/source/sha256sums.txt`,
    }),
  },
};

/** Parse one directory listing into entries for a simple profile. */
export function versionsFromListing(key, profile, source, hrefs) {
  const seen = new Map();
  for (const h of hrefs) {
    const v = profile.versionFrom(h.name);
    if (!v) continue;
    if (seen.has(v)) continue;
    const art = profile.artifact(v, source.base);
    seen.set(v, entryOf(key, v, source.name, art));
  }
  return sortVersionsDesc([...seen.values()]);
}

// ------------------------------------------------------------------- mysql --
const MYSQL_MIRRORS = [
  { name: 'aliyun', root: `${ALIYUN}/mysql/` },
  { name: 'huawei', root: `${HUAWEI}/mysql/Downloads/` },
];

export function mysqlUrlsForVersion(files, version) {
  const wantArch = arch();
  const darwin = [];
  const linux = [];
  const win = [];
  for (const f of files) {
    let m;
    if ((m = f.name.match(/^mysql-[\d.]+-macos(\d+)-(arm64|x86_64)\.tar\.gz$/)) && m[2] === wantArch) {
      darwin.push({ rank: Number(m[1]), url: f.url });
    } else if ((m = f.name.match(/^mysql-[\d.]+-linux-glibc([\d.]+)-(aarch64|x86_64)\.tar\.xz$/)) && m[2] === arch('linux')) {
      linux.push({ rank: Number(m[1]), url: f.url });
    } else if (/^mysql-[\d.]+-winx64\.zip$/.test(f.name)) {
      win.push({ rank: 0, url: f.url });
    }
  }
  const pick = (list) => list.sort((a, b) => b.rank - a.rank).map((p) => p.url);
  if (PLATFORM === 'darwin') return pick(darwin);
  if (PLATFORM === 'linux') return pick(linux);
  if (PLATFORM === 'win32') return pick(win);
  return [];
}

async function refreshMysql() {
  const errors = [];
  const entries = new Map();

  for (const mirror of orderSources(MYSQL_MIRRORS)) {
    try {
      const root = await fetchText(mirror.root, { timeout: 25000 });
      let majors = parseHrefs(root)
        .filter((h) => h.dir && /^MySQL-\d+\.\d+$/.test(h.name))
        .map((h) => h.name);
      majors = [...new Set(majors)].sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1])).slice(0, 6);

      await mapLimit(majors, 4, async (major) => {
        const base = new URL(`${major}/`, mirror.root).href;
        let html;
        try {
          html = await fetchText(base, { timeout: 25000 });
        } catch (e) {
          errors.push(`${mirror.name} ${major}: ${e.message.split('\n')[0]}`);
          return;
        }
        const files = parseHrefs(html)
          .filter((h) => !h.dir && /^mysql-[\d.]+-/.test(h.name))
          .map((h) => ({ name: h.name, url: new URL(h.href, base).href }));
        const byVersion = new Map();
        for (const f of files) {
          const m = f.name.match(/^mysql-(\d+\.\d+\.\d+)-/);
          if (!m) continue;
          if (!byVersion.has(m[1])) byVersion.set(m[1], []);
          byVersion.get(m[1]).push(f);
        }
        for (const [version, list] of byVersion) {
          const urls = mysqlUrlsForVersion(list, version);
          const prev = entries.get(version);
          if (prev) prev.urls = [...new Set([...prev.urls, ...urls])];
          else entries.set(version, entryOf('mysql', version, mirror.name, { urls, platformKnown: true }));
        }
      });
    } catch (e) {
      errors.push(`${mirror.name}: ${e.message.split('\n')[0]}`);
    }
  }

  // 8.4 / 9.x are not published on the mirrors above; discover their version
  // numbers from the official GitHub tag feed and resolve URLs lazily.
  try {
    const atom = await fetchText(MYSQL_ATOM, { timeout: 20000 });
    for (const m of atom.matchAll(/<title>mysql-(\d+\.\d+\.\d+)(?::[^<]*)?<\/title>/g)) {
      const version = m[1];
      if (!entries.has(version)) entries.set(version, entryOf('mysql', version, 'upstream'));
    }
  } catch (e) {
    errors.push(`github tags: ${e.message.split('\n')[0]}`);
  }

  if (!entries.size) throw new Error(`no MySQL index reachable\n  ${errors.join('\n  ')}`);
  return { source: 'aliyun+huawei+github', versions: sortVersionsDesc([...entries.values()]), errors };
}

export function mysqlUpstreamCandidates(version) {
  const major = version.split('.').slice(0, 2).join('.');
  const urls = [];
  if (PLATFORM === 'darwin') {
    const a = arch('darwin');
    for (const sdk of [15, 14, 13]) urls.push(`https://cdn.mysql.com/Downloads/MySQL-${major}/mysql-${version}-macos${sdk}-${a}.tar.gz`);
  } else if (PLATFORM === 'linux') {
    const a = arch('linux');
    for (const g of ['glibc2.28', 'glibc2.17']) urls.push(`https://cdn.mysql.com/Downloads/MySQL-${major}/mysql-${version}-linux-${g}-${a}.tar.xz`);
  } else {
    urls.push(`https://cdn.mysql.com/Downloads/MySQL-${major}/mysql-${version}-winx64.zip`);
  }
  return urls;
}

// ------------------------------------------------------------------ mongodb --
const LINUX_TARGETS = ['ubuntu2204', 'rhel90', 'debian12', 'rhel9', 'ubuntu2004', 'rhel8'];
const WIN_TARGETS = ['windows'];

export function mongoVersionEntries(json) {
  const out = [];
  for (const v of json.versions || []) {
    if (!/^\d+\.\d+\.\d+$/.test(String(v.version))) continue;
    if (v.development_release || v.release_candidate) continue;
    const urls = [];
    let sha256 = null;
    const downloads = (v.downloads || []).filter((d) => d.edition === 'base' && d.archive?.url);
    const find = (targets, archs) => {
      for (const target of targets) {
        for (const a of archs) {
          const hit = downloads.find((d) => d.target === target && d.arch === a);
          if (hit) return hit;
        }
      }
      return null;
    };
    if (PLATFORM === 'darwin') {
      const hit = find(['macos'], [arch('darwin'), 'arm64', 'x86_64']);
      if (hit) {
        urls.push(hit.archive.url);
        sha256 = hit.archive.sha256 || null;
      }
    } else if (PLATFORM === 'linux') {
      const hit = find(LINUX_TARGETS, [arch('linux'), 'x86_64']);
      if (hit) {
        urls.push(hit.archive.url);
        sha256 = hit.archive.sha256 || null;
      }
    } else {
      const hit = find(WIN_TARGETS, ['x86_64']);
      if (hit) {
        urls.push(hit.archive.url);
        sha256 = hit.archive.sha256 || null;
      }
    }
    if (!urls.length) continue;
    out.push(entryOf('mongodb', v.version, 'upstream', { urls, sha256 }));
  }
  return sortVersionsDesc(out);
}

async function refreshMongodb() {
  const text = await fetchText(MONGO_FULL, { timeout: 120000 });
  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new Error(`mongodb index is not valid JSON: ${e.message}`);
  }
  const versions = mongoVersionEntries(json);
  if (!versions.length) throw new Error('mongodb index contained no usable versions');
  return { source: 'mongodb.com', versions };
}

// ------------------------------------------------------------------- public --
export const SOURCE_ORDER = {
  mysql: ['aliyun', 'huawei', 'upstream'],
  mongodb: ['upstream'],
  postgres: ['aliyun', 'tencent', 'huawei', 'upstream'],
  redis: ['huawei', 'upstream'],
  mariadb: ['aliyun', 'tencent', 'huawei'],
  memcached: ['huawei', 'upstream'],
};

export async function refreshIndex(key) {
  if (key === 'mysql') return refreshMysql();
  if (key === 'mongodb') return refreshMongodb();

  const profile = PROFILES[key];
  if (!profile) throw new Error(`no index profile for "${key}"`);
  const errors = [];
  const merged = new Map();
  const used = [];
  for (const source of orderSources(profile.sources)) {
    try {
      const html = await fetchText(source.base, { timeout: 20000 });
      const versions = versionsFromListing(key, profile, source, parseHrefs(html));
      if (!versions.length) {
        errors.push(`${source.name}: no versions in listing`);
        continue;
      }
      used.push(source.name);
      for (const v of versions) if (!merged.has(v.version)) merged.set(v.version, v);
    } catch (e) {
      errors.push(`${source.name}: ${e.message.split('\n')[0]}`);
    }
  }
  if (!merged.size) throw new Error(`no ${key} index reachable\n  ${errors.join('\n  ')}`);
  return { source: used.join('+'), versions: sortVersionsDesc([...merged.values()]), errors };
}
