// Binary dependency inspection, per OS: otool -L on macOS, ldd on Linux.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { libInspector } from '../core/platform.js';
import { clientEnv } from '../core/env.js';

const SYSTEM_LIB_DIRS = ['/usr/lib', '/usr/lib64', '/lib', '/lib64', '/System/Library', '/Library/Apple'];

function within(file, dir) {
  const rel = path.relative(dir, file);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Dependencies that live neither inside the install nor in the OS: a payload that
 * links another tool's libraries only runs while that tool stays installed.
 */
export function foreignDeps(deps, root) {
  const roots = [path.resolve(root)];
  try {
    roots.push(fs.realpathSync(root));
  } catch {
    // root vanished; the plain path is all there is to compare against
  }
  return deps.filter((dep) => {
    if (SYSTEM_LIB_DIRS.some((dir) => within(dep, dir))) return false;
    return !roots.some((own) => within(dep, own));
  });
}

/**
 * @returns {{skipped:boolean, deps:string[], missing:string[]}}
 */
export function depsOf(bin) {
  const insp = libInspector();
  if (!insp || !bin) return { skipped: true, deps: [], missing: [] };
  const res = spawnSync(insp.cmd, [...insp.args, bin], { encoding: 'utf8', env: clientEnv(), timeout: 5000 });
  if (res.status !== 0 || !res.stdout || /is not an object file/i.test(res.stdout)) {
    return { skipped: true, deps: [], missing: [] };
  }

  const deps = [];
  const missing = [];
  if (insp.cmd === 'otool') {
    for (const line of res.stdout.split('\n').slice(1)) {
      const dep = line.trim().split(' (')[0];
      if (!dep || !dep.startsWith('/')) continue;
      if (dep.startsWith('/usr/lib') || dep.startsWith('/System')) continue;
      deps.push(dep);
      if (!fs.existsSync(dep)) missing.push(dep);
    }
  } else {
    // ldd: "libssl.so.3 => /lib/x86_64-linux-gnu/libssl.so.3 (0x…)" or "… => not found"
    for (const line of res.stdout.split('\n')) {
      const m = line.match(/^\s*(\S+)\s+=>\s+(not found|\S+)/);
      if (!m) continue;
      if (m[2] === 'not found') missing.push(m[1]);
      else if (m[2].startsWith('/')) deps.push(m[2]);
    }
  }
  return { skipped: false, deps, missing };
}
