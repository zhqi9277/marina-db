import fs from 'node:fs';
import path from 'node:path';
import { CATALOG, majorOf } from '../src/install/catalog.js';
import { sha256File } from '../src/install/download.js';
import { parseCatalog } from '../src/install/overlay.js';
import { artifactId, matrix } from './engine-matrix.mjs';

const MAX_ASSET_SIZE = 2 * 1024 ** 3;
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const print = (artifacts) => console.log(JSON.stringify({ schema: 1, artifacts }, null, 2));
const nameOf = (row) => artifactId(row) + (row.os === 'win32' ? '.zip' : '.tar.gz');
const keyOf = (row) => [row.key, row.os, row.arch, row.version].join('/');
const expected = new Map(matrix.map((row) => [nameOf(row), row]));

function requireAssetNames(names) {
  const missing = [...expected.keys()].filter((name) => !names.includes(name));
  if (missing.length || names.length !== expected.size) {
    throw new Error('expected ' + expected.size + ' archives, found ' + names.length + ', missing: ' + missing.join(', '));
  }
}

async function generate(dir, base) {
  const files = fs.readdirSync(dir).filter((name) => name !== 'manifest.json');
  requireAssetNames(files);
  const artifacts = [];
  for (const [fileName, row] of expected) {
    const file = path.join(dir, fileName);
    const { size } = fs.statSync(file);
    if (size <= 0 || size >= MAX_ASSET_SIZE) throw new Error(fileName + ' must be smaller than 2 GiB');
    const { engine, version, os, arch } = row;
    artifacts.push({
      name: CATALOG[engine].manifestName,
      version, major: majorOf(engine, version), os, arch, fileName, size,
      sha256: await sha256File(file),
      url: base + '/' + fileName,
    });
  }
  print(artifacts);
}

async function verify(file, releaseFile, base) {
  const artifacts = parseCatalog(read(file), { requireSize: true });
  requireAssetNames(artifacts.map((row) => row.fileName));
  const { draft, prerelease, assets } = read(releaseFile);
  if (draft || !prerelease || assets.length !== expected.size + 1) throw new Error('candidate release attachments are incomplete');
  const byName = new Map(assets.map((asset) => [asset.name, asset]));
  for (const row of artifacts) {
    const asset = byName.get(row.fileName);
    const target = expected.get(row.fileName);
    const url = base + '/' + row.fileName;
    if (keyOf(row) !== keyOf({ ...target, key: target.engine }) || row.url !== url ||
        !asset || asset.state !== 'uploaded' || asset.browser_download_url !== url ||
        asset.size !== row.size || asset.digest !== 'sha256:' + row.sha256) {
      throw new Error('release metadata does not match catalog for ' + row.fileName);
    }
  }
  const digest = await sha256File(file);
  const manifest = byName.get('manifest.json');
  if (manifest?.state !== 'uploaded' || manifest?.digest !== 'sha256:' + digest) {
    throw new Error('released manifest checksum mismatch');
  }
  console.log(digest);
}

function merge(previous, candidate) {
  const artifacts = new Map(parseCatalog(read(previous), { requireSize: true }).map((row) => [keyOf(row), row]));
  for (const row of parseCatalog(read(candidate), { requireSize: true })) {
    const id = keyOf(row);
    const existing = artifacts.get(id);
    if (existing && existing.sha256 !== row.sha256) throw new Error('published binaries cannot be replaced in place: ' + id);
    if (!existing) artifacts.set(id, row);
  }
  print([...artifacts.values()].map(({ key, ...row }) => row));
}

const [command, ...args] = process.argv.slice(2);
if (command === 'generate') await generate(...args);
else if (command === 'verify') await verify(...args);
else if (command === 'merge') merge(...args);
else throw new Error('usage: make-manifest.mjs generate <directory> <release base> | verify <manifest> <release JSON> <release base> | merge <stable> <candidate>');
