// Decide whether a live process belongs to this marina install.
// POSIX compares paths as the OS returned them. Windows folds case and accepts
// both separators, because command lines mix `\` and `/`.
import fs from 'node:fs';
import path from 'node:path';

function realpathOf(target) {
  try {
    return fs.realpathSync(target);
  } catch {
    return null;
  }
}

function fold(value, caseInsensitive) {
  const text = String(value);
  if (!caseInsensitive) return text;
  return text.replace(/\\/g, '/').toLowerCase();
}

function escapePattern(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Resolve the version when the OS exposes a path into a concrete payload. */
export function installVersion(details, ctx, caseInsensitive) {
  const key = ctx.engine?.key || ctx.key;
  const sep = '/';
  const prefix = escapePattern(fold(`${sep}engines${sep}${key}${sep}${ctx.major}${sep}`, caseInsensitive));
  const version = new RegExp(`${prefix}(\\d+(?:\\.\\d+){1,2})(?=${escapePattern(sep)}|[\\s"']|$)`);
  for (const text of [details.command, details.cwd].filter(Boolean)) {
    const hit = fold(text, caseInsensitive).match(version);
    if (hit) return hit[1];
  }
  return null;
}

/**
 * @param {{command?: string|null, cwd?: string|null}} details
 * @param {object} ctx
 * @param {{caseInsensitive?: boolean}} [policy]
 */
export function matchesInstall(details, ctx, { caseInsensitive = false } = {}) {
  const texts = [details.command, details.cwd].filter(Boolean);
  if (!texts.length) return false;
  const pathApi = caseInsensitive ? path.win32 : path.posix;
  const sep = pathApi.sep;
  const roots = installPaths(ctx)
    .filter(Boolean)
    .flatMap((root) => {
      const resolved = pathApi.resolve(root);
      if (caseInsensitive) return [resolved];
      const real = realpathOf(root);
      return real && real !== resolved ? [resolved, real] : [resolved];
    });
  const foldedTexts = texts.map((text) => fold(text, caseInsensitive));
  const foldedRoots = roots.map((root) => fold(root, caseInsensitive));
  if (foldedRoots.some((root) => {
    const boundary = new RegExp(`(?:^|[=\\s"'])${escapePattern(root)}(?=${escapePattern(fold(sep, caseInsensitive))}|[\\s"']|$)`);
    return foldedTexts.some((text) => boundary.test(text));
  })) return true;
  if (details.cwd) {
    const cwd = fold(details.cwd, caseInsensitive);
    const boundary = fold(sep, caseInsensitive);
    if (foldedRoots.some((root) => cwd === root || cwd.startsWith(root + boundary))) return true;
  }
  return false;
}

export function installPaths(ctx) {
  return [ctx.root, ctx.majorDir, ctx.dataDir, ctx.confFile, ctx.logFile, ctx.pidFile].filter(Boolean);
}
