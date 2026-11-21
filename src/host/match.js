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

function marinaLayout(ctx, sep) {
  const key = ctx.engine?.key || ctx.key;
  const major = ctx.major === undefined || ctx.major === null ? '' : String(ctx.major);
  if (!key || !major) return { needles: [], suffixes: [] };
  const data = `${sep}data${sep}${key}${sep}${major}`;
  return {
    needles: [
      `${sep}engines${sep}${key}${sep}${major}${sep}`,
      `${data}${sep}`,
      `${sep}etc${sep}${key}${sep}${major}${sep}`,
      `${sep}run${sep}${key}-${major}.pid`,
    ],
    suffixes: [data],
  };
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
  const sep = caseInsensitive ? '/' : path.sep;
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
 * @param {{caseInsensitive?: boolean, allowLayout?: boolean, extraPaths?: string[]}} [policy]
 */
export function matchesInstall(details, ctx, { caseInsensitive = false, allowLayout = true, extraPaths = [] } = {}) {
  const texts = [details.command, details.cwd].filter(Boolean);
  if (!texts.length) return false;
  const pathApi = caseInsensitive ? path.win32 : path;
  const sep = pathApi.sep;
  const roots = [...installPaths(ctx), ...extraPaths]
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
  if (!allowLayout) return false;

  const { needles, suffixes } = marinaLayout(ctx, sep);
  const foldedNeedles = needles.map((needle) => fold(needle, caseInsensitive));
  const foldedSuffixes = suffixes.map((suffix) => fold(suffix, caseInsensitive));
  return foldedTexts.some(
    (text) =>
      foldedNeedles.some((needle) => text.includes(needle)) ||
      foldedSuffixes.some((suffix) => text === suffix || text.endsWith(suffix)),
  );
}

export function installPaths(ctx) {
  return [ctx.root, ctx.majorDir, ctx.dataDir, ctx.confFile, ctx.logFile, ctx.pidFile].filter(Boolean);
}
