// GitHub Actions and the manifest generator use the same release matrix.
import { pathToFileURL } from 'node:url';
import { readdirSync, readFileSync } from 'node:fs';
import { CATALOG } from '../src/install/catalog.js';

export const targets = [
  { runner: 'macos-15-intel', os: 'darwin', arch: 'x64' },
  { runner: 'macos-15', os: 'darwin', arch: 'arm64' },
  { runner: 'ubuntu-22.04', os: 'linux', arch: 'x64' },
  { runner: 'ubuntu-22.04-arm', os: 'linux', arch: 'arm64' },
  { runner: 'windows-2022', os: 'win32', arch: 'x64' },
];

const versions = {
  mysql: '8.4.11',
  mariadb: '11.4.13',
  postgres: '17.11',
  mongodb: '7.0.45',
  redis: '7.4.11',
  memcached: '1.6.45',
};

const baseline = targets.flatMap((target) => Object.entries(versions).map(([engine, version]) => ({
  ...target,
  engine,
  version: target.os === 'win32' && engine === 'memcached' ? '1.6.8' : version,
})));

export function artifactId({ engine, version, os, arch }) {
  return [engine, version, os === 'win32' ? 'windows' : os, arch].join('-');
}

export function readBuildMatrix(tag = '') {
  if (process.env.MARINA_ENGINE_PLAN) {
    return parseBuildMatrix(JSON.parse(readFileSync(process.env.MARINA_ENGINE_PLAN, 'utf8')));
  }
  if (tag.startsWith('engines-candidate-history-')) throw new Error('the historical candidate requires its locked plan');
  if (!tag.includes('--')) return baseline;
  const batch = /^engines-candidate-([a-z0-9]+(?:-[a-z0-9]+)*)--[a-z0-9]+$/.exec(tag)?.[1];
  if (!batch) throw new Error('invalid engine batch tag: ' + tag);
  const file = new URL('./engine-batches/' + batch + '.json', import.meta.url);
  return parseBuildMatrix(JSON.parse(readFileSync(file, 'utf8')));
}

export function parseBuildMatrix(plan) {
  if (!Array.isArray(plan) || !plan.length || plan.length > 256) {
    throw new Error('an engine batch must specify 1 to 256 builds');
  }
  const seen = new Set();
  return plan.map(({ engine, version, os, arch, inputs }) => {
    const target = targets.find((row) => row.os === os && row.arch === arch);
    if (!target || !Object.hasOwn(CATALOG, engine) ||
        typeof version !== 'string' || !/^\d+\.\d+(?:\.\d+)?$/.test(version)) {
      throw new Error('invalid engine batch target: ' + [engine, version, os, arch].join(' '));
    }
    const row = { ...target, engine, version, inputs };
    const id = artifactId(row);
    if (seen.has(id)) throw new Error('duplicate engine batch target: ' + id);
    seen.add(id);
    return row;
  });
}

export function selectEnginePlan(engine, { versions = '', platforms = '', historyDir } = {}) {
  if (!Object.hasOwn(CATALOG, engine)) throw new Error('unknown engine: ' + engine);
  const requestedVersions = versions.split(',').map((item) => item.trim()).filter(Boolean);
  const requestedPlatforms = platforms.split(',').map((item) => item.trim()).filter(Boolean);
  if (requestedVersions.some((version) => !/^\d+\.\d+(?:\.\d+)?$/.test(version))) {
    throw new Error('enter exact engine versions separated by commas');
  }
  const dir = historyDir ? pathToFileURL(historyDir.replace(/\/?$/, '/')) : new URL('./engine-batches/', import.meta.url);
  const rows = historyDir ? [] : baseline.filter((row) => row.engine === engine);
  const available = new Map(rows.map((row) => [artifactId(row), row]));
  const batchNames = historyDir || requestedVersions.length ? readdirSync(dir).sort() : [];
  const locked = new Set();
  for (const name of batchNames) {
    if (!name.startsWith(engine + '-') || !name.endsWith('.json')) continue;
    const plan = parseBuildMatrix(JSON.parse(readFileSync(new URL(name, dir), 'utf8')));
    for (const row of plan) {
      if (row.engine !== engine || !row.inputs) throw new Error('unexpected entry in ' + name);
      if (requestedVersions.length && !requestedVersions.includes(row.version)) continue;
      const id = artifactId(row);
      if (locked.has(id)) throw new Error('multiple locked plans for ' + id);
      locked.add(id);
      available.set(id, row);
    }
  }
  const platformOf = ({ os, arch }) => `${os}-${arch}`;
  const selected = [...available.values()].filter((row) =>
    (!requestedVersions.length || requestedVersions.includes(row.version)) &&
    (!requestedPlatforms.length || requestedPlatforms.includes(platformOf(row))));
  for (const version of requestedVersions) {
    if (!selected.some((row) => row.version === version)) throw new Error('no locked targets selected for ' + version);
  }
  for (const platform of requestedPlatforms) {
    if (!selected.some((row) => platformOf(row) === platform)) throw new Error('no locked targets selected for ' + platform);
  }
  return parseBuildMatrix(selected);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Only the scheduling fields belong in Actions' matrix output.
  const include = readBuildMatrix(process.argv[2] || process.env.GITHUB_REF_NAME).map(({ inputs, ...row }) => row);
  console.log(JSON.stringify({ include }));
}
