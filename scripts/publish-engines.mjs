import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getEngine } from '../src/core/registry.js';
import { CATALOG } from '../src/install/catalog.js';
import { downloadFile } from '../src/install/download.js';
import { parseCatalog } from '../src/install/overlay.js';
import { setQuiet } from '../src/ui/console.js';
import { parseBuildMatrix } from './engine-matrix.mjs';
import { archiveName, catalogArtifact, describeArchive, MAX_ASSET_SIZE, mergeCatalog } from './make-manifest.mjs';

const MAX_RELEASE_ASSETS = 1000;
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const gh = (...args) => execFileSync('gh', args, {
  encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'],
});
const { GITHUB_REPOSITORY, GITHUB_SERVER_URL, RUN_ID, MIGRATE_ENGINE } = process.env;
const repo = 'repos/' + GITHUB_REPOSITORY;
const downloads = GITHUB_SERVER_URL + '/' + GITHUB_REPOSITORY + '/releases/download/';
const releaseBase = (tag) => downloads + tag + '/';
const tagFor = (engine, part) => 'engines-' + engine + (part === 1 ? '' : '-' + part);

function pages(endpoint) {
  return JSON.parse(gh('api', '--paginate', '--slurp', endpoint + '?per_page=100')).flat();
}

function assets(release) {
  return new Map(pages(repo + '/releases/' + release.id + '/assets').map((asset) => [asset.name, asset]));
}

function groupedReleases(engine) {
  const prefix = tagFor(engine, 1);
  return pages(repo + '/releases').flatMap((release) => {
    const { tag_name: tag } = release;
    const suffix = tag.startsWith(prefix + '-') ? tag.slice(prefix.length + 1) : '';
    if (tag !== prefix && (!/^[1-9]\d*$/.test(suffix) || Number(suffix) < 2)) return [];
    return [{ ...release, part: suffix ? Number(suffix) : 1, assets: assets(release) }];
  }).sort((a, b) => a.part - b.part);
}

function validatedBuilds(evidence) {
  const plan = parseBuildMatrix(readJson(path.join(evidence, 'engine-plan.json')));
  const dir = path.join(evidence, 'validated');
  if (fs.readdirSync(dir).length !== plan.length || plan.some((row) => row.engine !== plan[0].engine)) {
    throw new Error('expected validation records for one complete engine build plan');
  }
  return plan.map((row) => {
    const fileName = archiveName(row);
    const { fileName: recordedName, size, sha256 } = readJson(path.join(dir, fileName + '.json'));
    if (recordedName !== fileName || !Number.isSafeInteger(size) || size <= 0 || size >= MAX_ASSET_SIZE ||
        !/^[a-f0-9]{64}$/.test(sha256 ?? '')) {
      throw new Error('invalid validation record for ' + fileName);
    }
    return { ...row, fileName, size, sha256 };
  });
}

function legacyBuilds(previous, engine) {
  return parseCatalog(previous, { requireSize: true }).flatMap((row) => {
    if (row.key !== engine || !row.url.startsWith(downloads + 'engines-candidate-')) return [];
    const build = { ...row, engine };
    const source = row.url.slice(downloads.length).split('/');
    if (!/^engines-candidate-[A-Za-z0-9._-]+$/.test(source[0]) || source.length !== 2 ||
        source[1] !== archiveName(build) || row.fileName !== source[1] || row.size >= MAX_ASSET_SIZE) {
      throw new Error('invalid legacy asset URL: ' + row.url);
    }
    return [build];
  });
}

function verifyAsset(asset, build, tag, { draft = false } = {}) {
  if (asset?.state !== 'uploaded' || asset.digest !== 'sha256:' + build.sha256 || asset.size !== build.size ||
      (!draft && asset.browser_download_url !== releaseBase(tag) + build.fileName)) {
    throw new Error('release attachment does not match the verified archive: ' + tag + '/' + build.fileName);
  }
}

function createRelease(engine, tag) {
  gh('release', 'create', tag, '--draft', '--latest=false', '--target', process.env.GITHUB_SHA,
    '--title', 'Marina ' + getEngine(engine).label + ' engine packages',
    '--notes', 'Validated database packages for Marina. Each archive targets a specific version and platform.');
}

async function uploadBuild(build, target) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marina-release-'));
  try {
    const { fileName, size, sha256, engine, version } = build;
    const file = path.join(dir, fileName);
    if (RUN_ID) {
      gh('run', 'download', RUN_ID, '--name', ['engine', engine, version, build.os, build.arch].join('-'), '--dir', dir);
      const actual = await describeArchive(file, build);
      if (actual.size !== size || actual.sha256 !== sha256) throw new Error('build artifact changed: ' + fileName);
    } else {
      await downloadFile(build.url, file, { size, sha256 });
    }
    const existing = target.assets.get(fileName);
    if (existing) {
      // GitHub can leave a zero-byte placeholder after a failed upload.
      gh('api', '--method', 'DELETE', repo + '/releases/assets/' + existing.id);
    }
    gh('release', 'upload', target.tag_name, file);
    console.error('Uploaded ' + fileName + ' to ' + target.tag_name);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function publish(previous, builds) {
  const engine = builds[0].engine;
  const releases = groupedReleases(engine);
  const byName = new Map();
  for (const release of releases) {
    release.pending = [];
    release.used = release.assets.size;
    for (const name of release.assets.keys()) {
      if (byName.has(name)) throw new Error('asset appears in multiple grouped Releases: ' + name);
      byName.set(name, release);
    }
  }

  const touched = new Set();
  const updates = builds.map((build) => {
    let target = byName.get(build.fileName);
    const asset = target?.assets.get(build.fileName);
    if (asset && !(asset.state === 'starter' && asset.size === 0)) {
      verifyAsset(asset, build, target.tag_name, target);
    } else {
      if (!target) {
        target = releases.at(-1);
        if (!target || target.immutable || target.used >= MAX_RELEASE_ASSETS) {
          const part = (target?.part ?? 0) + 1;
          target = { part, tag_name: tagFor(engine, part), draft: true, assets: new Map(), pending: [], used: 0 };
          releases.push(target);
        }
        target.used++;
      }
      target.pending.push(build);
    }
    touched.add(target);
    return catalogArtifact(build, { fileName: build.fileName, size: build.size, sha256: build.sha256 },
      releaseBase(target.tag_name) + build.fileName);
  });

  // Reject conflicts in the catalog before creating Releases or uploading files.
  const manifest = mergeCatalog(previous, { schema: 1, artifacts: updates });
  for (const release of touched) {
    const tag = release.tag_name;
    if (!release.id) createRelease(engine, tag);
    for (const build of release.pending) await uploadBuild(build, release);
    if (release.draft) gh('release', 'edit', tag, '--draft=false', '--latest=false');
  }

  for (const { tag_name: tag } of touched) {
    const release = JSON.parse(gh('api', repo + '/releases/tags/' + tag));
    if (release.draft) throw new Error('grouped Release is still a draft: ' + tag);
    const published = assets(release);
    for (const row of updates.filter(({ url }) => url.startsWith(releaseBase(tag)))) {
      verifyAsset(published.get(row.fileName), row, tag);
    }
  }
  return manifest;
}

const [previousFile, evidence] = process.argv.slice(2);
if (!previousFile || Boolean(RUN_ID) === Boolean(MIGRATE_ENGINE) ||
    (RUN_ID && !/^\d+$/.test(RUN_ID)) || (MIGRATE_ENGINE && !Object.hasOwn(CATALOG, MIGRATE_ENGINE))) {
  throw new Error('choose one build run or one engine to migrate');
}
const previous = readJson(previousFile);
const builds = RUN_ID ? validatedBuilds(evidence) : legacyBuilds(previous, MIGRATE_ENGINE);
setQuiet(true);
console.log(JSON.stringify(builds.length ? await publish(previous, builds) : previous, null, 2));
