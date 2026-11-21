// Engine capability metadata + build recipes.
//
// IMPORTANT: no version numbers and no download URLs live here. Versions are
// discovered remotely by src/install/indexing.js (Chinese mirrors first, official
// upstream as fallback) and cached under runtime/cache/index/ as a result of
// that query — never shipped as a list in the source tree.
import { PLATFORM } from '../core/platform.js';

export const CATALOG = {
  mysql: {
    manifestName: 'mysql',
    label: 'MySQL',
    kind: 'binary',
    platforms: ['darwin', 'linux', 'win32'],
    // how many leading version components form the installed "major" directory:
    // 8.4.11 -> engines/mysql/8.4/8.4.11
    majorDepth: 2,
  },

  mongodb: {
    manifestName: 'mongodb',
    label: 'MongoDB',
    kind: 'binary',
    platforms: ['darwin', 'linux', 'win32'],
    // 7.0.45 -> engines/mongodb/7.0/7.0.45
    majorDepth: 2,
  },

  postgres: {
    manifestName: 'postgresql',
    label: 'PostgreSQL',
    kind: 'source',
    platforms: ['darwin', 'linux', 'win32'],
    // 17.11 -> engines/postgres/17/17.11
    majorDepth: 1,
    build: {
      jobs: 6,
      steps: [
        ['./configure', '--prefix={root}', '--without-readline', '--without-zlib', '--without-icu'],
        ['make', '-j{jobs}'],
        ['make', 'install'],
      ],
      bins: {},
      minutes: '3-6',
    },
    unsupportedReason: {
      win32: 'PostgreSQL ships a Windows .pkg installer; source builds need MSVC — use WSL',
    },
  },

  redis: {
    manifestName: 'redis',
    label: 'Redis',
    kind: 'source',
    platforms: ['darwin', 'linux', 'win32'],
    // 7.4.11 -> engines/redis/7/7.4.11
    majorDepth: 1,
    build: {
      jobs: 8,
      steps: [['make', '-j{jobs}', 'MALLOC=libc']],
      bins: {
        'redis-server': 'src/redis-server',
        'redis-cli': 'src/redis-cli',
        'redis-benchmark': 'src/redis-benchmark',
        'redis-check-aof': 'src/redis-check-aof',
        'redis-check-rdb': 'src/redis-check-rdb',
        'redis-sentinel': 'src/redis-sentinel',
      },
      seconds: '20-60',
    },
    unsupportedReason: {
      win32: 'Redis has no Windows build and needs make — run marina inside WSL, or use Memurai',
    },
  },

  mariadb: {
    manifestName: 'mariadb',
    label: 'MariaDB',
    kind: 'source',
    platforms: ['darwin', 'linux', 'win32'],
    majorDepth: 2,
    build: {
      jobs: 6,
      steps: [['node', '{repo}/scripts/build-mariadb-source.mjs', '{root}']],
      minutes: '10-20',
    },
    reason: 'MariaDB macOS source build requires cmake and the Command Line Tools',
  },

  memcached: {
    manifestName: 'memcached',
    label: 'Memcached',
    kind: 'source',
    platforms: ['darwin', 'linux'],
    majorDepth: 1,
    build: {
      jobs: 6,
      steps: [['node', '{repo}/scripts/build-memcached-source.mjs', '{root}']],
      minutes: '2-5',
    },
    reason: 'Memcached source build requires make and the Command Line Tools',
  },
};

export function catalogKeyOf(manifestName) {
  return Object.keys(CATALOG).find((k) => CATALOG[k].manifestName === manifestName) || null;
}

export function catalogEntry(key) {
  return CATALOG[key] || null;
}

export function majorDepth(key) {
  return CATALOG[key]?.majorDepth || 2;
}

/** "8.4.11" -> "8.4" for mysql; "7.4.11" -> "7" for redis, per engine metadata. */
export function majorOf(key, version) {
  const depth = majorDepth(key);
  return String(version).split('.').slice(0, depth).join('.');
}

export function buildRecipe(key) {
  return CATALOG[key]?.build || null;
}

/** why this engine cannot be installed on this platform, or null */
export function platformProblem(key, platform = PLATFORM) {
  const e = CATALOG[key];
  if (!e) return 'unknown engine';
  if (key === 'mariadb') {
    if (platform === 'linux' && process.arch !== 'x64' && process.arch !== 'x86_64') return 'MariaDB Linux bintar is available for x86_64; use a prebuilt artifact for this architecture';
  }
  if (key === 'redis' && platform === 'win32') return 'Redis on Windows needs a pinned prebuilt artifact';
  if (!e.platforms || !e.platforms.includes(platform)) {
    return e.unsupportedReason?.[platform] || e.reason || `${e.label} is not supported on ${platform}`;
  }
  if (e.kind === 'source' && !e.build) {
    return e.reason || `${e.label} source build is not automated yet`;
  }
  return null;
}
