// Detect generated config files that still point at a different marina root.
// This happens when the project directory is moved: the configs are generated
// with absolute paths, and starting the engine would otherwise wait for a full
// timeout before failing with a misleading error.
import fs from 'node:fs';
import path from 'node:path';
import { HOME } from './paths.js';

// `key = /abs` (ini/my.cnf), `key: /abs` (mongod.yaml) and `key /abs`
// (redis.conf) all show up in the configs marina generates.
const DIRECTIVES = [
  /^\s*[\w.-]+\s*=\s*(\/[^\s]+)/, // key = /path
  /^\s*[\w.-]+\s*:\s*(\/[^\s]+)/, // key: /path (YAML)
  /^\s*[\w.-]+\s+(\/[^\s]+)/, // key /path (space-separated)
];

/** `<base>` or `<base>/…` — avoids matching major 7 against .../70 */
function underBase(target, base) {
  return target === base || target.includes(`${base}${path.sep}`) || target.endsWith(base);
}

/** True when `target` looks like something marina generated (any root). */
function looksLikeMarinaPath(target, ctx) {
  const sep = path.sep;
  if (target.includes(`${sep}runtime${sep}`)) return true;
  const key = ctx?.key || ctx?.engine?.key;
  const major = ctx?.major;
  if (!key || major === undefined || major === null || major === '') return false;
  const line = String(major);
  return (
    underBase(target, `${sep}engines${sep}${key}`) ||
    underBase(target, `${sep}data${sep}${key}${sep}${line}`) ||
    underBase(target, `${sep}etc${sep}${key}${sep}${line}`) ||
    target.includes(`${sep}run${sep}${key}-${line}.`)
  );
}

/**
 * @returns {string[]} absolute paths in the config that do not live under HOME
 */
export function staleConfigReferences(ctx) {
  if (!ctx?.confFile) return [];
  let text;
  try {
    text = fs.readFileSync(ctx.confFile, 'utf8');
  } catch {
    return [];
  }
  const home = path.resolve(HOME) + path.sep;
  const stale = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    let target = null;
    for (const directive of DIRECTIVES) {
      const m = trimmed.match(directive);
      if (m) {
        target = m[1];
        break;
      }
    }
    if (!target || !looksLikeMarinaPath(target, ctx)) continue;
    if (path.resolve(target).startsWith(home)) continue;
    stale.push(target);
  }
  return stale;
}
