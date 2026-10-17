// install / use / remove: version management and payload handling.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import {
  dirs, ensureDirs, engineDir, versionDir, cacheDir, mkdirp,
} from './paths.js';
import { downloadFile, sha256File } from './download.js';
import { extractTar, discoverRoot, listDirs } from './archive.js';
import {
  parseRef, installedVersions, pickVersion, buildCtx,
  syncCurrentSymlink, ensureVersionDirs,
} from './registry.js';
import {
  buildRecipe, catalogKeyOf, majorOf, platformProblem,
} from './catalog.js';
import { resolveVersion, resolveArtifact } from './versions.js';
import { linkFile, PLATFORM, OS_LABEL } from './platform.js';
import { findArtifact } from './overlay.js';
import * as state from './state.js';
import { start, stop, restart, healthy } from './lifecycle.js';
import { ok, info, warn, hint, color } from './ui.js';

/** Best-effort version extraction from a local file name. */
function versionFromFilename(file) {
  const base = path.basename(file);
  const m = base.match(/(\d+\.\d+(?:\.\d+)?)/);
  return m ? m[1] : null;
}

/** `--port` must fail before any download so a typo cannot write a bad config. */
function validatePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('port must be 1..65535');
  return port;
}

/**
 * Turn "<db>[@version]" into a concrete download plan.
 *
 * Precedence (unified pipeline):
 *   1 --file                     a local payload the user handed us
 *   2 overlay                    our own prebuilt artifact, matched by (engine, version, os, arch)
 *   3 remote index               discovered from mirrors / official sources, then HEAD-checked
 */
export async function resolveTarget(ref, { file = null, version = null } = {}) {
  const { engine, tag } = parseRef(ref);

  if (file) {
    const ver = version || versionFromFilename(file);
    if (!ver) throw new Error(`cannot infer version from ${path.basename(file)} — pass --version`);
    return {
      engine,
      major: majorOf(engine.key, ver),
      version: ver,
      kind: 'binary',
      channel: 'file',
      urls: [path.resolve(file)],
      file: path.resolve(file),
      sha256: null,
    };
  }

  const entry = await resolveVersion(engine, tag || version);
  const key = catalogKeyOf(engine.manifestName);

  // our own prebuilt artifact beats every upstream rule, including platform limits
  const overlayHit = await findArtifact({ manifestName: engine.manifestName, version: entry.version });
  if (overlayHit) {
    return {
      engine,
      major: entry.major,
      version: entry.version,
      kind: 'binary',
      channel: 'overlay',
      urls: [overlayHit.url],
      sha256: overlayHit.sha256 || null,
      indexSource: 'overlay',
    };
  }

  const problem = platformProblem(key, PLATFORM);
  if (problem) {
    throw new Error(
      `${engine.label} ${entry.version} on ${OS_LABEL}: ${problem}\n` +
        `  hint: marina remote ${engine.key} (versions are still listed) · or provide a prebuilt artifact via MARINA_CATALOG_FILE`,
    );
  }

  const artifact = await resolveArtifact(entry, { engine: engine.key });
  return {
    engine,
    major: entry.major,
    version: entry.version,
    kind: entry.kind,
    channel: 'index',
    urls: [artifact.url],
    sha256: artifact.sha256,
    build: entry.kind === 'source' ? buildRecipe(key) : null,
    indexSource: entry.indexSource,
    stale: entry.stale,
  };
}

export async function fetchPackage(target) {
  if (target.file) {
    mkdirp(cacheDir(target.engine.key, target.version));
    const dest = path.join(cacheDir(target.engine.key, target.version), path.basename(target.file));
    // always refresh the cache: the same file name can be replaced by the user,
    // and reusing the previous copy would install a stale payload silently
    // (a --file pointing inside the cache is already in place — copying it onto
    // itself would fail)
    if (path.resolve(target.file) !== path.resolve(dest)) fs.copyFileSync(target.file, dest);
    const sha = await sha256File(dest);
    return { tarball: dest, sha256: sha };
  }

  let lastError = null;
  for (const url of target.urls || []) {
    const name = path.basename(new URL(url).pathname);
    const dest = path.join(mkdirp(cacheDir(target.engine.key, target.version)), name);
    try {
      await downloadFile(url, dest, { sha256: target.sha256, label: name });
      return { tarball: dest, sha256: target.sha256 || (await sha256File(dest)) };
    } catch (e) {
      lastError = e;
      warn(`${name}: ${e.message.split('\n')[0]}`);
    }
  }
  throw lastError || new Error(`no download URL for ${target.engine.label} ${target.version}`);
}

/** Source tarballs wrap everything in one top-level dir. */
function singleTopDir(dir) {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => !e.name.startsWith('.'));
    if (entries.length === 1 && entries[0].isDirectory()) return path.join(dir, entries[0].name);
  } catch {}
  return null;
}

/** Compile a source payload in place and expose its binaries under bin/. */
async function buildSource(root, build, engine) {
  if (!build) throw new Error(`${engine.label}: no build recipe`);
  const { spawnAsync } = await import('./archive.js');
  const jobs = build.jobs || Math.min(8, os.cpus().length);
  info(`building ${engine.label} from source (${build.minutes || build.seconds || 'a while'})`);
  for (const [cmd, ...rest] of build.steps) {
    const args = rest.map((a) => String(a).replace('{jobs}', String(jobs)).replace('{root}', root));
    const label = `${cmd} ${args.join(' ')}`.trim();
    const res = await spawnAsync(cmd, args, { cwd: root });
    if (res.code !== 0) {
      const tail = (res.stderr || res.stdout || '').trim().split('\n').slice(-12).join('\n');
      throw new Error(`build step failed: ${label}\n${tail}`);
    }
  }
  const mappings = build.bins || {};
  if (Object.keys(mappings).length) {
    const binDir = path.join(root, 'bin');
    mkdirp(binDir);
    for (const [name, rel] of Object.entries(mappings)) {
      const target = path.join(root, rel);
      if (!fs.existsSync(target)) continue;
      linkFile(target, path.join(binDir, name));
    }
  }
}

/**
 * Extract a verified tarball into engines/<key>/<major>/<version>.
 *
 * `target.tarball` must already be downloaded. A complete payload is reused
 * unless `force` is set; an incomplete one is removed and re-extracted. A dest
 * created (or healed) here is removed again when extraction/rename/build fails,
 * so a later install never mistakes a half-built payload for a usable one.
 */
export async function materializePayload(target, engine, { force = false } = {}) {
  const tarball = target.tarball || target.file;
  if (!tarball) throw new Error('materializePayload: target.tarball is required');
  const { major, version } = target;
  const markers = engine.markers || [];
  ensureVersionDirs(engine, major);
  const dest = versionDir(engine.key, major, version);

  if (fs.existsSync(dest)) {
    if (!force && discoverRoot(dest, markers)) {
      info(`${engine.label} ${version} is already installed — reusing payload (use --force to re-extract)`);
      return { dest, reused: true };
    }
    if (!force) warn(`${engine.label} ${version} payload is incomplete — re-extracting`);
    fs.rmSync(dest, { recursive: true, force: true });
  }

  const stage = path.join(engineDir(engine.key, major), `.stage-${crypto.randomBytes(4).toString('hex')}`);
  fs.rmSync(stage, { recursive: true, force: true });
  // only a dest renamed into place by this call may be removed on failure: a
  // concurrent install can win the rename, and its payload must survive
  let created = false;
  try {
    await extractTar(tarball, stage);
    if (target.kind === 'source') {
      const top = singleTopDir(stage);
      fs.renameSync(top || stage, dest);
      created = true;
      await buildSource(dest, target.build, engine);
    } else {
      const root = discoverRoot(stage, markers);
      if (!root) {
        throw new Error(
          `unrecognized payload layout under ${stage}\n` +
          `  expected one of: ${markers.join(', ')}`,
        );
      }
      fs.renameSync(root, dest);
      created = true;
    }
  } catch (e) {
    if (created) fs.rmSync(dest, { recursive: true, force: true });
    throw e;
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
  return { dest, reused: false };
}

export function renderConfig(ctx, { force = false } = {}) {
  const text = ctx.engine.renderConfig?.(ctx);
  if (!text) return { skipped: true };
  if (fs.existsSync(ctx.confFile) && !force) return { skipped: true, path: ctx.confFile };
  mkdirp(path.dirname(ctx.confFile));
  fs.writeFileSync(ctx.confFile, text);
  return { path: ctx.confFile, written: true };
}

export async function install(ref, opts = {}) {
  // validate before resolving the target (and before any network / extraction)
  const port = opts.port === undefined || opts.port === null ? null : validatePort(opts.port);
  ensureDirs();
  const target = await resolveTarget(ref, opts);
  const { engine, major, version } = target;

  const origin = target.file
    ? target.file
    : `${target.kind === 'source' ? 'source build' : 'binary'} · ${target.indexSource || target.channel} · ${target.urls?.[0] || ''}`;
  info(`${engine.label} ${version}  ${color.gray(`(${origin})`)}`);
  if (target.stale) warn('version index is a stale cache (network refresh failed)');

  const { tarball, sha256 } = await fetchPackage(target);
  await materializePayload({ ...target, tarball }, engine, { force: opts.force });

  if (port !== null) state.setPort(engine.key, major, port);
  const ctx = buildCtx(engine, { major, version });
  if (!ctx.root) throw new Error(`payload for ${engine.label} ${version} is incomplete`);

  const cfg = renderConfig(ctx, { force: opts.force });
  if (cfg.written) ok(`config written: ${cfg.path}`);

  const init = await engine.init?.(ctx);
  if (init?.created) ok(`datadir initialized: ${ctx.dataDir}`);

  const wasRunning = await healthy(ctx);
  if (!wasRunning) {
    await start(ctx, { quiet: true });
    // first-run bootstrap only for a datadir we just created
    if (engine.postInit && init?.created) {
      try {
        await engine.postInit(ctx);
        ok('first-run bootstrap done (root credentials / cleanup)');
      } catch (e) {
        warn(`post-init step failed: ${e.message.split('\n')[0]}`);
      }
    }
    await stop(ctx, { quiet: true });
  } else {
    warn(`${engine.label} was already running — skipped first-run bootstrap`);
  }

  const active = state.getActive(engine.key);
  if (opts.use !== false || !active || opts.setActive) {
    state.setActive(engine.key, version);
    ok(`active ${engine.key} -> ${version}`);
  }
  syncCurrentSymlink(engine, major, state.getActive(engine.key) || version);

  return {
    key: engine.key,
    label: engine.label,
    major,
    version,
    port: ctx.port,
    dataDir: ctx.dataDir,
    confFile: ctx.confFile,
    sha256,
    source: target.indexSource || target.channel,
  };
}

export async function use(ref, { restart: doRestart = false, quiet = false } = {}) {
  const { engine, tag } = parseRef(ref);
  const pick = pickVersion(engine, tag);
  if (!pick) {
    throw new Error(`${engine.label} ${tag || ''} is not installed\n  hint: marina install ${engine.key}@${tag || ''}`);
  }
  const prevVersion = state.getActive(engine.key);
  const ctx = buildCtx(engine, pick);

  // switching the active version while the old one runs: stop it first
  if (prevVersion && prevVersion !== pick.version) {
    const prev = installedVersions(engine).find((r) => r.version === prevVersion);
    if (prev) {
      const prevCtx = buildCtx(engine, prev);
      if (await healthy(prevCtx)) {
        await stop(prevCtx, { quiet: true });
        if (!quiet) info(`stopped ${engine.label} ${prevVersion}`);
      }
    }
  }

  state.setActive(engine.key, pick.version);
  syncCurrentSymlink(engine, pick.major, pick.version);

  if (doRestart) await restart(ctx, { quiet });
  return { engine, ctx, version: pick.version, previous: prevVersion };
}

export async function remove(ref, { purge = false } = {}) {
  const { engine, tag } = parseRef(ref);
  const pick = pickVersion(engine, tag);
  if (!pick) throw new Error(`${engine.label} ${tag || ''} is not installed`);
  const ctx = buildCtx(engine, pick);

  if (await healthy(ctx)) await stop(ctx, { quiet: true });

  fs.rmSync(versionDir(engine.key, pick.major, pick.version), { recursive: true, force: true });

  const remaining = installedVersions(engine);
  if (state.getActive(engine.key) === pick.version) {
    const next = remaining.filter((r) => r.major === pick.major).pop() || remaining.pop();
    if (next) state.setActive(engine.key, next.version);
    else state.setActive(engine.key, null);
  }
  const stillHasMajor = installedVersions(engine).some((r) => r.major === pick.major);
  if (!stillHasMajor) {
    try { fs.rmSync(path.join(engineDir(engine.key, pick.major), 'current'), { force: true }); } catch {}
  } else {
    const next = state.getActive(engine.key);
    if (next) syncCurrentSymlink(engine, pick.major, next);
  }

  let purged = false;
  if (purge && !stillHasMajor) {
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
    purged = true;
  }
  return { engine, pick, purged, remaining };
}

export function majorList(engine) {
  const base = path.join(dirs.engines, engine.key);
  return listDirs(base);
}
