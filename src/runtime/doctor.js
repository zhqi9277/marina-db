// Environment self-check, shared by `marina doctor` and the TUI doctor view.
// Local checks only.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirs, ensureDirs } from '../core/paths.js';
import { OS_LABEL, host } from '../core/platform.js';
import { engineList, activeCtx } from '../core/registry.js';
import { status, tcpProbe } from './lifecycle.js';
import { findBin } from '../install/archive.js';
import { depsOf, foreignDeps } from '../install/libcheck.js';

/**
 * @returns {Promise<Array<{name:string, value:string, ok:boolean}>>}
 */
export async function runDoctor() {
  const checks = [];

  const nodeMajor = Number(process.versions.node.split('.')[0]);
  checks.push({ name: 'platform', value: `${OS_LABEL} ${process.arch}`, ok: true });
  checks.push({ name: 'node', value: process.versions.node, ok: nodeMajor >= 18 });

  let tar = spawnSync('tar', ['--version'], { encoding: 'utf8' });
  if (!tar.error && tar.status !== 0) tar = spawnSync('tar', ['--help'], { encoding: 'utf8' });
  checks.push({ name: 'tar', value: (tar.stdout || tar.stderr || '').split('\n')[0] || 'missing', ok: tar.status === 0 });

  let writable = true;
  try {
    ensureDirs();
    fs.accessSync(dirs.root, fs.constants.W_OK);
  } catch {
    writable = false;
  }
  checks.push({ name: 'MARINA_HOME', value: dirs.root, ok: writable });

  const libProblems = [];
  let inspected = 0;
  for (const engine of engineList) {
    if (!host.libInspector()) break;
    const ctx = activeCtx(engine);
    if (!ctx) continue;
    const bin = findBin(ctx.root, engine.serverBin || []);
    const deps = depsOf(bin);
    if (deps.skipped) {
      libProblems.push(`${engine.key}: could not inspect the server binary`);
      continue;
    }
    inspected++;
    for (const dep of deps.missing) libProblems.push(`${engine.key}: ${dep} (missing)`);
    for (const dep of foreignDeps(deps.deps.filter((d) => !deps.missing.includes(d)), ctx.root)) {
      libProblems.push(`${engine.key}: ${dep} (outside install)`);
    }
  }
  checks.push({
    name: 'libs',
    value: host.libInspector()
      ? libProblems.length
        ? libProblems.join(', ')
        : inspected ? `all inspected engine libraries are self-contained (${inspected} checked)` : 'no installed engine binaries to inspect'
      : `skipped on ${OS_LABEL} (no library inspector)`,
    ok: !host.libInspector() || libProblems.length === 0,
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
