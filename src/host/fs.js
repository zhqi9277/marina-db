// Directory and file links. Windows passes 'junction'; POSIX passes 'dir'.
// A refused symlink (no privilege, or a filesystem without them) becomes a copy.
import fs from 'node:fs';
import path from 'node:path';

export function linkDir(target, link, symlinkType) {
  try {
    // recursive: an older real directory (e.g. a previous Windows copy
    // fallback) must be removed entirely, otherwise cpSync would nest the new
    // payload inside it instead of replacing it.
    fs.rmSync(link, { recursive: true, force: true });
  } catch {}
  try {
    fs.symlinkSync(path.resolve(target), link, symlinkType);
    return 'symlink';
  } catch {
    fs.cpSync(target, link, { recursive: true });
    return 'copy';
  }
}

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
