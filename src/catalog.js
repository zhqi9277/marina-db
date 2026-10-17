// Engine capability metadata + build recipes.
//
// IMPORTANT: no version numbers and no download URLs live here. Versions are
// discovered remotely by src/indexing.js (Chinese mirrors first, official
// upstream as fallback) and cached under runtime/cache/index/ as a result of
// that query — never shipped as a list in the source tree.
import { PLATFORM } from './platform.js';

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
    platforms: ['darwin', 'linux'],
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
    platforms: ['darwin', 'linux'],
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
    platforms: [], // no macOS binary upstream; source build (cmake + boost) not automated yet
    majorDepth: 2,
    build: null,
    reason:
      'MariaDB publishes no macOS binary; an automated source build (cmake + boost, 10-20 min) is not implemented yet',
  },

  memcached: {
    manifestName: 'memcached',
    label: 'Memcached',
    kind: 'source',
    platforms: [], // needs libevent; source build not automated yet
    majorDepth: 1,
    build: null,
    reason:
      'memcached has no macOS build and needs libevent; an automated source build is not implemented yet',
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
  if (!e.platforms || !e.platforms.includes(platform)) {
    return e.unsupportedReason?.[platform] || e.reason || `${e.label} is not supported on ${platform}`;
  }
  if (e.kind === 'source' && !e.build) {
    return e.reason || `${e.label} source build is not automated yet`;
  }
  return null;
}
