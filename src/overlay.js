// Optional prebuilt-artifact overlay: point marina at your own release manifest.
//
//   MARINA_CATALOG_FILE=/path/manifest.json
//   MARINA_CATALOG_URL=https://…/manifest.json
//
// Shape (see scripts/make-manifest.mjs):
//   { "artifacts": [ { name, version, major, os, arch, fileName, size, sha256, url } ] }
//
// When an artifact matches (engine + version + this OS + this arch) it wins over
// the remote index (mirrors / official upstream) and is the only way to install
// an engine the upstreams do not publish for this platform: build once in CI,
// publish the tarballs, point marina at the manifest.
import fs from 'node:fs';
import { PLATFORM, env } from './platform.js';
import { fetchJson } from './download.js';
import { warn } from './ui.js';

let cache = null;

export function archToken() {
  if (process.arch === 'arm64') return 'arm64';
  return process.platform === 'win32' ? 'x64' : 'x86_64';
}

function normalizeArch(a) {
  if (a === 'aarch64') return 'arm64';
  if (a === 'x86_64') return 'x86_64';
  if (a === 'x64') return process.platform === 'win32' ? 'x64' : 'x86_64';
  return a;
}

/** manifests in the wild write "macos" / "windows"; compare on node platform names */
export function normalizeOs(os) {
  const s = String(os || '').toLowerCase();
  if (!s) return '';
  if (s === 'macos' || s === 'mac' || s === 'osx' || s === 'darwin') return 'darwin';
  if (s === 'windows' || s === 'win' || s === 'win32') return 'win32';
  if (s === 'linux') return 'linux';
  return s;
}

export async function loadOverlay() {
  if (cache !== null) return cache;
  const file = env('CATALOG_FILE');
  const url = env('CATALOG_URL');
  if (!file && !url) {
    cache = [];
    return cache;
  }
  try {
    const raw = file ? JSON.parse(fs.readFileSync(file, 'utf8')) : await fetchJson(url);
    cache = Array.isArray(raw) ? raw : raw.artifacts || raw.packages || [];
  } catch (e) {
    warn(`catalog overlay unavailable (${e.message.split('\n')[0]})`);
    cache = [];
  }
  return cache;
}

export async function findArtifact({ manifestName, version }) {
  const list = await loadOverlay();
  if (!list.length) return null;
  const wantArch = archToken();
  return (
    list.find(
      (a) =>
        a.name === manifestName &&
        String(a.version) === String(version) &&
        normalizeOs(a.os) === PLATFORM &&
        normalizeArch(a.arch) === normalizeArch(wantArch),
    ) || null
  );
}
