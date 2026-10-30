// Environment self-check, shared by `marina doctor` and the TUI doctor view.
// Local checks only: no network, no index refresh.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirs, ensureDirs } from './paths.js';
import { OS_LABEL, host } from './platform.js';
import { engineList, activeCtx } from './registry.js';
import { status, tcpProbe } from './lifecycle.js';
import { findBin } from './archive.js';
import { depsOf } from './libcheck.js';
import { indexCacheInfo } from './versions.js';

/**
 * @returns {Promise<Array<{name:string, value:string, ok:boolean}>>}
 */
export async function runDoctor() {
  const checks = [];

  const nodeMajor = Number(process.versions.node.split('.')[0]);
  checks.push({ name: 'platform', value: `${OS_LABEL} ${process.arch}`, ok: true });
  checks.push({ name: 'node', value: process.versions.node, ok: nodeMajor >= 18 });

  const tar = spawnSync('tar', ['--version'], { encoding: 'utf8' });
  checks.push({ name: 'tar', value: (tar.stdout || tar.stderr || '').split('\n')[0] || 'missing', ok: tar.status === 0 });

  let writable = true;
  try {
    ensureDirs();
    fs.accessSync(dirs.root, fs.constants.W_OK);
  } catch {
    writable = false;
  }
  checks.push({ name: 'MARINA_HOME', value: dirs.root, ok: writable });

  const idx = indexCacheInfo();
  checks.push({
    name: 'index',
    value: idx.files
      ? `${idx.engines.length} engines cached${idx.newest ? ` · last refresh ${new Date(idx.newest).toLocaleString()}` : ''}`
      : 'not fetched yet — run: marina remote --refresh',
    ok: idx.files > 0,
  });

  const missingLibs = [];
  let inspected = 0;
  for (const engine of engineList) {
    const ctx = activeCtx(engine);
    if (!ctx || !ctx.root) continue;
    const bin = findBin(ctx.root, engine.serverBin || []);
    if (!bin) continue;
    const deps = depsOf(bin);
    if (deps.skipped) continue;
    inspected++;
    for (const dep of deps.missing) missingLibs.push(`${engine.key}: ${dep}`);
  }
  checks.push({
    name: 'libs',
    value: host.libInspector()
      ? missingLibs.length
        ? missingLibs.join(', ')
        : `all engine dylibs resolve (${inspected} checked)`
      : 'skipped on Windows (no otool/ldd)',
    ok: !host.libInspector() || missingLibs.length === 0,
  });

  const conflicts = [];
  for (const engine of engineList) {
    const ctx = activeCtx(engine);
    if (!ctx) continue;
    if (await tcpProbe(ctx.port)) {
      const st = await status(ctx);
      if (st.state === 'port-busy') conflicts.push(`${engine.key} port ${ctx.port}`);
    }
  }
  checks.push({
    name: 'ports',
    value: conflicts.length ? conflicts.join(', ') : 'no foreign listeners',
    ok: conflicts.length === 0,
  });

  return checks;
}
