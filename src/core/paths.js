// Filesystem hierarchy. The program and everything it manages sit side by side:
//
//   <project>/bin, <project>/src        the CLI itself
//   <project>/runtime/                  everything marina installs or generates
//     engines/<db>/<major>/<version>/   downloaded payload (+ "current" symlink)
//     data/<db>/<major>/                datadir, never touched by upgrades
//     etc/<db>/<major>/                 generated config
//     logs/<db>/<major>.log
//     run/<db>-<major>.pid|.sock
//     cache/<db>/<version>/*.tar.gz     verified downloads
//     shims/<bin>                       PATH shims
//     state.json                        active versions + ports
//
// MARINA_HOME overrides the runtime root; a global npm install falls back to ~/.marina
// because the package directory itself is not writable.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { env } from './platform.js';

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(SRC_DIR, '..');

function defaultHome() {
  if (env('HOME')) return env('HOME');
  const local = path.join(PROJECT_ROOT, 'runtime');
  try {
    fs.mkdirSync(local, { recursive: true });
    fs.accessSync(local, fs.constants.W_OK);
    return local;
  } catch {
    return path.join(os.homedir(), '.marina');
  }
}

export const HOME = defaultHome();

export const dirs = {
  root: HOME,
  engines: path.join(HOME, 'engines'),
  data: path.join(HOME, 'data'),
  etc: path.join(HOME, 'etc'),
  logs: path.join(HOME, 'logs'),
  run: path.join(HOME, 'run'),
  cache: path.join(HOME, 'cache'),
  shims: path.join(HOME, 'shims'),
  tmp: path.join(HOME, 'tmp'),
};

export function ensureDirs() {
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
}

/** engines/<db>/<major> */
export function engineDir(key, major) {
  return path.join(dirs.engines, key, major);
}

/** engines/<db>/<major>/<version> */
export function versionDir(key, major, version) {
  return path.join(engineDir(key, major), version);
}

/** engines/<db>/<major>/current */
export function currentDir(key, major) {
  return path.join(engineDir(key, major), 'current');
}

export function etcDir(key, major) {
  return path.join(dirs.etc, key, major);
}

export function dataDir(key, major) {
  return path.join(dirs.data, key, major);
}

export function logDir(key) {
  return path.join(dirs.logs, key);
}

export function runFile(key, major, ext) {
  return path.join(dirs.run, `${key}-${major}.${ext}`);
}

/** cache/<db>/<version>/ */
export function cacheDir(key, version) {
  return path.join(dirs.cache, key, version);
}

export function mkdirp(p) {
  fs.mkdirSync(p, { recursive: true });
  return p;
}
