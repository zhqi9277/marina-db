// Write managed configuration atomically and retain the previous contents during a change.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdirp } from '../core/paths.js';

function writeConfig(file, text) {
  mkdirp(path.dirname(file));
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, text, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export function renderConfig(ctx, { force = false } = {}) {
  if (!ctx.confFile) return { skipped: true };
  if (fs.existsSync(ctx.confFile) && !force) return { skipped: true, path: ctx.confFile };
  const text = ctx.engine.renderConfig?.(ctx);
  if (!text) return { skipped: true };
  writeConfig(ctx.confFile, text);
  return { path: ctx.confFile, written: true };
}
