// GitHub Actions and the manifest generator use the same release matrix.
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Only the scheduling fields belong in Actions' matrix output.
  const include = readBuildMatrix(process.argv[2] || process.env.GITHUB_REF_NAME).map(({ inputs, ...row }) => row);
  console.log(JSON.stringify({ include }));
}
