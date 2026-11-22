// GitHub Actions and the manifest generator use the same release matrix.
import { pathToFileURL } from 'node:url';

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

export const matrix = targets.flatMap((target) => Object.entries(versions).map(([engine, version]) => ({
  ...target,
  engine,
  version: target.os === 'win32' && engine === 'memcached' ? '1.6.8' : version,
})));

export function artifactId({ engine, version, os, arch }) {
  return [engine, version, os === 'win32' ? 'windows' : os, arch].join('-');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify({ include: matrix }));
}
