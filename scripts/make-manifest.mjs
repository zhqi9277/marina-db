import fs from 'node:fs';
import path from 'node:path';
import { CATALOG, majorOf } from '../src/install/catalog.js';
import { sha256File } from '../src/install/download.js';
import { parseCatalog } from '../src/install/overlay.js';
import { artifactId } from './engine-matrix.mjs';

export const MAX_ASSET_SIZE = 2 * 1024 ** 3;
export const archiveName = (row) => artifactId(row) + (row.os === 'win32' ? '.zip' : '.tar.gz');

export async function describeArchive(file, target) {
  const fileName = archiveName(target);
  if (path.basename(file) !== fileName) throw new Error('expected archive ' + fileName);
  const { size } = fs.statSync(file);
  if (size <= 0 || size >= MAX_ASSET_SIZE) throw new Error(fileName + ' must be smaller than 2 GiB');
  return { fileName, size, sha256: await sha256File(file) };
}

export function catalogArtifact({ engine, version, os, arch }, archive, url) {
  return { name: CATALOG[engine].manifestName, version, major: majorOf(engine, version), os, arch, ...archive, url };
}

export function mergeCatalog(previous, updates) {
  const keyOf = (row) => [row.key, row.version, row.os, row.arch].join('/');
  const artifacts = new Map(parseCatalog(previous, { requireSize: true }).map((row) => [keyOf(row), row]));
  for (const row of parseCatalog(updates, { requireSize: true })) {
    const id = keyOf(row);
    const existing = artifacts.get(id);
    if (existing && (existing.sha256 !== row.sha256 || existing.size !== row.size)) {
      throw new Error('published binaries cannot be replaced in place: ' + id);
    }
    artifacts.set(id, row);
  }
  return { schema: 1, artifacts: [...artifacts.values()].map(({ key, ...row }) => row) };
}
