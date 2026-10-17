// Platform abstraction: the one place that knows about macOS / Linux / Windows.
import fs from 'node:fs';
import path from 'node:path';

export const IS_MAC = process.platform === 'darwin';
export const IS_LINUX = process.platform === 'linux';
export const IS_WIN = process.platform === 'win32';
export const PLATFORM = process.platform;
export const OS_LABEL = IS_MAC ? 'macOS' : IS_LINUX ? 'Linux' : 'Windows';

/** read MARINA_<name> */
export function env(name, fallback = undefined) {
  const v = process.env[`MARINA_${name}`];
  return v !== undefined ? v : fallback;
}

const MASONRY = {
  darwin: { arm64: 'arm64', x64: 'x86_64' },
  linux: { arm64: 'aarch64', x64: 'x86_64' },
  win32: { arm64: 'arm64', x64: 'x64' },
};

/** package-name architecture token (mysql uses arm64/x86_64, linux uses aarch64) */
export function arch(platform = PLATFORM) {
  return (MASONRY[platform] || MASONRY.darwin)[process.arch] || 'x86_64';
}

export function exe(name) {
  return IS_WIN ? `${name}.exe` : name;
}

/** MySQL names macOS builds after the SDK major (macos13/14/15). */
export function macosSdkTags() {
  const release = Number((env('OS_RELEASE') || '15').split('.')[0]) || 15;
  const top = Math.min(15, Math.max(13, release));
  return [top, top - 1, top - 2].filter((n) => n >= 13);
}

/** extraction flags per archive suffix (bsdtar on win10+ understands gz/xz/zip) */
export function tarArgs(file) {
  if (file.endsWith('.tar.gz') || file.endsWith('.tgz')) return ['-xzf'];
  if (file.endsWith('.tar.xz')) return ['-xJf'];
  if (file.endsWith('.tar.bz2')) return ['-xjf'];
  if (file.endsWith('.zip')) return ['-xf'];
  return ['-xf'];
}

/** command used to inspect a binary's library dependencies, or null */
export function libInspector() {
  if (IS_MAC) return { cmd: 'otool', args: ['-L'] };
  if (IS_LINUX) return { cmd: 'ldd', args: [] };
  return null; // Windows: no ldd/otool; skipped
}

/** symlink a directory; falls back to a copy when the OS refuses (Windows) */
export function linkDir(target, link) {
  try {
    fs.rmSync(link, { force: true });
  } catch {}
  try {
    fs.symlinkSync(path.resolve(target), link, IS_WIN ? 'junction' : 'dir');
    return 'symlink';
  } catch {
    fs.cpSync(target, link, { recursive: true });
    return 'copy';
  }
}

/** symlink a single file; falls back to a copy */
export function linkFile(target, link) {
  try {
    fs.rmSync(link, { force: true });
  } catch {}
  try {
    fs.symlinkSync(target, link, 'file');
    return 'symlink';
  } catch {
    fs.copyFileSync(target, link);
    return 'copy';
  }
}
