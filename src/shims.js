// PATH shims: runtime/shims/<bin> -> marina shim-exec <bin>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirs, ensureDirs } from './paths.js';
import { engineList, activeCtx } from './registry.js';
import { findBin } from './archive.js';
import { host } from './host/index.js';

const CLI = fileURLToPath(new URL('../bin/marina.js', import.meta.url));

export function shimScript(bin) {
  return host.shimScript(bin, process.execPath, CLI);
}

export function installShims() {
  ensureDirs();
  const created = [];
  const wanted = new Set();
  for (const engine of engineList) {
    const ctx = activeCtx(engine);
    if (!ctx || !ctx.root) continue;
    for (const bin of engine.clientBins) {
      const target = findBin(ctx.root, [bin]);
      if (!target) continue;
      const dest = path.join(dirs.shims, host.shimFileName(bin));
      wanted.add(path.basename(dest));
      fs.writeFileSync(dest, shimScript(bin), { mode: 0o755 });
      created.push({ bin, target });
    }
  }
  const managed = new Set(engineList.flatMap((engine) =>
    engine.clientBins.map((bin) => host.shimFileName(bin))));
  for (const name of managed) {
    if (!wanted.has(name)) fs.rmSync(path.join(dirs.shims, name), { force: true });
  }
  return created;
}

export function resolveBin(bin) {
  for (const engine of engineList) {
    if (!engine.clientBins.includes(bin)) continue;
    const ctx = activeCtx(engine);
    // this engine is not installed/active — another engine may still provide
    // the same client (mariadb ships mysql, for example)
    if (!ctx || !ctx.root) continue;
    const found = findBin(ctx.root, [bin]);
    if (found) return { engine, ctx, path: found };
  }
  return null;
}

export function shellenv() {
  return host.shellenv(dirs.root, dirs.shims);
}
