// Binary dependency inspection, per OS: otool -L on macOS, ldd on Linux.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { libInspector } from './platform.js';

/**
 * @returns {{skipped:boolean, deps:string[], missing:string[]}}
 */
export function depsOf(bin) {
  const insp = libInspector();
  if (!insp || !bin) return { skipped: true, deps: [], missing: [] };
  const res = spawnSync(insp.cmd, [...insp.args, bin], { encoding: 'utf8' });
  if (res.status !== 0 || !res.stdout) return { skipped: true, deps: [], missing: [] };

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
