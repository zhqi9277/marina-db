// Detect generated config files that still point at a different marina root.
// This happens when the project directory is moved: the configs are generated
// with absolute paths, and starting the engine would otherwise wait for a full
// timeout before failing with a misleading error.
import fs from 'node:fs';
import path from 'node:path';
import { HOME } from './paths.js';

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
    const m = trimmed.match(/=\s*(\/[^\s]+)/);
    if (!m) continue;
    const target = m[1];
    if (!target.includes(`${path.sep}runtime${path.sep}`)) continue;
    if (path.resolve(target).startsWith(home)) continue;
    stale.push(target);
  }
  return stale;
}
