// The major directory belongs to an engine's data and configuration, so its
// depth is kept independent of the version and platform offered by a catalog.
export const CATALOG = {
  mysql: { manifestName: 'mysql', majorDepth: 2 },
  mongodb: { manifestName: 'mongodb', majorDepth: 2 },
  postgres: { manifestName: 'postgresql', majorDepth: 1 },
  redis: { manifestName: 'redis', majorDepth: 1 },
  mariadb: { manifestName: 'mariadb', majorDepth: 2 },
  memcached: { manifestName: 'memcached', majorDepth: 1 },
  qdrant: { manifestName: 'qdrant', majorDepth: 1 },
};

export function majorDepth(key) {
  return CATALOG[key]?.majorDepth || 2;
}

export function majorOf(key, version) {
  return String(version).split('.').slice(0, majorDepth(key)).join('.');
}
