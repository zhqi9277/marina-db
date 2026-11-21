// install / use / remove: version management and payload handling.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import {
  dirs, ensureDirs, engineDir, versionDir, currentDir, cacheDir, mkdirp,
} from '../core/paths.js';
import { downloadFile, sha256File } from './download.js';
import { extractTar, discoverRoot, listDirs } from './archive.js';
import {
  parseRef, installedVersions, pickVersion, buildCtx,
  syncCurrentSymlink, ensureVersionDirs, isInstalled, majorPick, pendingInstallFile,
} from '../core/registry.js';
import {
  buildRecipe, catalogKeyOf, majorOf, platformProblem,
} from './catalog.js';
import { pickEntry, resolveVersion, resolveArtifact } from './versions.js';
import { linkFile, PLATFORM, OS_LABEL } from '../core/platform.js';
import { overlayArtifacts } from './overlay.js';
import { buildEnv } from '../core/env.js';
import { installShims } from '../runtime/shims.js';
import * as state from '../core/state.js';
import { configSnapshot, renderConfig, syncVersionConfig } from '../runtime/config.js';
import { start, stop, restart, inspectService } from '../runtime/lifecycle.js';
import { withInstanceLock } from '../runtime/instance-lock.js';
import { ok, info, warn, hint, color } from '../ui/console.js';

/** Best-effort version extraction from a local file name. */
function versionFromFilename(file) {
  const base = path.basename(file);
  const m = base.match(/(\d+\.\d+(?:\.\d+)?)/);
  return m ? m[1] : null;
}

export { renderConfig } from '../runtime/config.js';

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
    const inferred = versionFromFilename(file);
    const ver = version || inferred || tag;
    if (!ver) throw new Error(`cannot infer version from ${path.basename(file)} — pass --version`);
    if (!/^\d+(?:\.\d+){1,2}$/.test(ver)) throw new Error(`invalid version: ${ver}`);
    if (tag && tag !== ver && tag !== majorOf(engine.key, ver)) {
      throw new Error(`${engine.key}@${tag} does not match local package version ${ver}`);
    }
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

  const key = catalogKeyOf(engine.manifestName);

  const prebuilt = (await overlayArtifacts(engine.manifestName))
    .map((artifact) => ({ ...artifact, version: String(artifact.version), major: majorOf(engine.key, artifact.version) }))
    .sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
  const overlayHit = pickEntry(engine.key, prebuilt, tag || version);
  if (overlayHit) {
    return {
      engine,
      major: overlayHit.major,
      version: overlayHit.version,
      kind: 'binary',
      channel: 'overlay',
      urls: [overlayHit.url],
      sha256: overlayHit.sha256 || null,
      indexSource: 'overlay',
    };
  }

  const entry = await resolveVersion(engine, tag || version);
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
    const res = await spawnAsync(cmd, args, { cwd: root, env: buildEnv() });
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

export async function install(ref, opts = {}) {
  // validate before resolving the target (and before any network / extraction)
  const port = opts.port == null ? null : state.validatePort(opts.port);
  ensureDirs();
  const target = await resolveTarget(ref, opts);
  const { engine, major } = target;
  return withInstanceLock({ key: engine.key, major }, () => installTarget(target, opts, port));
}

async function installTarget(target, opts, port) {
  const { engine, major, version } = target;
  const previous = majorPick(engine, major);
  const previousCtx = buildCtx(engine, previous || { major, version });
  const service = inspectService(previousCtx);
  if (service.unknown) throw new Error(`cannot verify ${engine.key}@${major} process ownership`);
  const portChanged = port !== null && port !== previousCtx.port;
  if (service.owned && (portChanged || (opts.force && service.runningVersion === version))) {
    throw new Error(`stop ${engine.key}@${service.runningVersion} before replacing its payload or changing its port`);
  }
  const makeActive = opts.use !== false || opts.setActive;
  const selected = makeActive || !previous ? version : previous.version;

  const origin = target.file
    ? target.file
    : `${target.kind === 'source' ? 'source build' : 'binary'} · ${target.indexSource || target.channel} · ${target.urls?.[0] || ''}`;
  info(`${engine.label} ${version}  ${color.gray(`(${origin})`)}`);
  if (target.stale) warn('version index is a stale cache (network refresh failed)');

  const { tarball, sha256 } = await fetchPackage(target);
  const pending = pendingInstallFile(engine, major, version);
  const interrupted = fs.existsSync(pending);
  const wasInstalled = isInstalled(engine, major, version);
  const destination = versionDir(engine.key, major, version);
  const backup = path.join(path.dirname(destination), `.backup-${version}`);
  const restoreConfig = configSnapshot(previousCtx);
  mkdirp(path.dirname(pending));
  fs.writeFileSync(pending, '');
  let ctx;
  try {
    if (wasInstalled && opts.force) fs.renameSync(destination, backup);
    await materializePayload({ ...target, tarball }, engine, { force: opts.force || interrupted });
    ctx = buildCtx(engine, { major, version, port });
    if (!ctx.root) throw new Error(`payload for ${engine.label} ${version} is incomplete`);

    if (!service.owned) {
      const cfg = renderConfig(ctx, { force: opts.force || portChanged });
      if (cfg.written) ok(`config written: ${cfg.path}`);
      const bootstrap = path.join(ctx.etcDir, '.bootstrap-pending');
      const init = await engine.init?.(ctx);
      if (init?.created) {
        ok(`datadir initialized: ${ctx.dataDir}`);
        if (engine.postInit) fs.writeFileSync(bootstrap, '');
      }
      await start(ctx, { quiet: true });
      try {
        if (engine.postInit && fs.existsSync(bootstrap)) {
          await engine.postInit(ctx);
          fs.rmSync(bootstrap, { force: true });
          ok('first-run bootstrap done (root credentials / cleanup)');
        }
      } finally {
        await stop(ctx, { quiet: true });
      }
    } else {
      warn(`${engine.label} ${service.runningVersion} is running — deferred startup check for ${version}`);
    }

    const selectedCtx = selected === version ? ctx : previousCtx;
    syncVersionConfig(selectedCtx);
    syncCurrentSymlink(engine, major, selected);
    state.selectVersion(engine.key, major, selected, { active: makeActive, port });
  } catch (error) {
    const live = ctx && inspectService(ctx);
    if (!service.owned && (live?.unknown || (live?.owned && live.runningVersion === version))) throw error;
    restoreConfig();
    if (!wasInstalled || fs.existsSync(backup)) fs.rmSync(destination, { recursive: true, force: true });
    if (fs.existsSync(backup)) fs.renameSync(backup, destination);
    restoreCurrent(engine, major, previous);
    fs.rmSync(pending, { force: true });
    throw error;
  }
  fs.rmSync(pending, { force: true });
  fs.rmSync(backup, { recursive: true, force: true });
  if (makeActive) ok(`active ${engine.key} -> ${version}`);

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

function restoreCurrent(engine, major, pick) {
  if (pick) syncCurrentSymlink(engine, major, pick.version);
  else fs.rmSync(currentDir(engine.key, major), { recursive: true, force: true });
}

export function reconfigure(ctx) {
  return withInstanceLock(ctx, () => {
    const pick = majorPick(ctx.engine, ctx.major);
    if (!pick) throw new Error(`${ctx.key}@${ctx.major} is no longer installed`);
    const selected = buildCtx(ctx.engine, pick);
    const result = renderConfig(selected, { force: true });
    syncCurrentSymlink(ctx.engine, ctx.major, pick.version);
    return { ...result, version: pick.version };
  });
}

export async function use(ref, { restart: doRestart = false, quiet = false } = {}) {
  const { engine, tag } = parseRef(ref);
  const pick = pickVersion(engine, tag);
  if (!pick) {
    throw new Error(`${engine.label} ${tag || ''} is not installed\n  hint: marina install ${engine.key}@${tag || ''}`);
  }
  return withInstanceLock({ key: engine.key, major: pick.major }, () => useVersion(engine, pick, doRestart, quiet));
}

async function useVersion(engine, pick, doRestart, quiet) {
  if (!isInstalled(engine, pick.major, pick.version)) throw new Error(`${engine.key}@${pick.version} is no longer installed`);
  const prevVersion = state.getActive(engine.key);
  const ctx = buildCtx(engine, pick);
  const previousSelection = majorPick(engine, pick.major);
  const restoreConfig = configSnapshot(ctx);
  const stopped = [];
  let started = false;
  const prev = prevVersion && installedVersions(engine).find((row) => row.version === prevVersion);
  const previousCtx = prev && prev.major !== pick.major ? buildCtx(engine, prev) : null;

  // switching the active version while the old one runs: stop it first
  try {
    for (const candidate of [ctx, previousCtx].filter(Boolean)) {
      const live = inspectService(candidate);
      if (live.unknown) throw new Error(`cannot verify ${candidate.key}@${candidate.major} process ownership`);
      if (!live.owned || live.runningVersion === pick.version) continue;
      const running = buildCtx(engine, { major: candidate.major, version: live.runningVersion });
      if ((await stop(running, { quiet: true })).stopped) {
        stopped.push(running);
        if (!quiet) info(`stopped ${engine.label} ${running.version}`);
      }
    }
    syncVersionConfig(ctx);
    syncCurrentSymlink(engine, pick.major, pick.version);
    if (doRestart) started = (await restart(ctx, { quiet })).started;
    state.selectVersion(engine.key, pick.major, pick.version, { active: true });
  } catch (error) {
    if (started) await stop(ctx, { quiet: true });
    restoreConfig();
    restoreCurrent(engine, pick.major, previousSelection);
    for (const running of stopped) {
      try { await start(running, { quiet: true }); } catch (rollbackError) {
        throw new Error(`${error.message}\nCould not restart ${running.key}@${running.version}: ${rollbackError.message}`, { cause: error });
      }
    }
    throw error;
  }
  return { engine, ctx, version: pick.version, previous: prevVersion };
}

export async function remove(ref, { purge = false } = {}) {
  const { engine, tag } = parseRef(ref);
  const pick = pickVersion(engine, tag);
  if (!pick) throw new Error(`${engine.label} ${tag || ''} is not installed`);
  return withInstanceLock({ key: engine.key, major: pick.major }, () => removeVersion(engine, pick, purge));
}

async function removeVersion(engine, pick, purge) {
  if (!isInstalled(engine, pick.major, pick.version)) throw new Error(`${engine.key}@${pick.version} is no longer installed`);
  const ctx = buildCtx(engine, pick);
  const live = inspectService(ctx);
  if (live.unknown) throw new Error(`cannot verify ${ctx.key}@${ctx.major} process ownership`);
  if (live.owned && live.runningVersion === pick.version) await stop(ctx, { quiet: true });

  fs.rmSync(versionDir(engine.key, pick.major, pick.version), { recursive: true, force: true });

  const remaining = installedVersions(engine);
  const selected = majorPick(engine, pick.major, remaining);
  state.mutate((current) => {
    const id = `${engine.key}:${pick.major}`;
    if (selected) current.selected[id] = selected.version;
    else delete current.selected[id];
    if (current.active[engine.key] !== pick.version) return;
    const fallback = selected || remaining.at(-1);
    if (fallback) current.active[engine.key] = fallback.version;
    else delete current.active[engine.key];
  });
  restoreCurrent(engine, pick.major, selected);
  if (selected) syncVersionConfig(buildCtx(engine, selected));

  let purged = false;
  if (purge && !selected && !(live.owned && live.runningVersion !== pick.version)) {
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
    purged = true;
  }
  installShims();
  return { engine, pick, purged, remaining };
}

export function majorList(engine) {
  const base = path.join(dirs.engines, engine.key);
  return listDirs(base);
}
