// Login autostart: one OS hook that starts the enabled databases.
// The host renders and loads it: LaunchAgent, systemd --user, or a logon task.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirs, ensureDirs } from '../core/paths.js';
import { darwin, host, linux, win32 } from '../host/index.js';
import { systemdEscape, xmlEscape } from '../host/escape.js';
import * as state from '../core/state.js';

const BY_MANAGER = { launchd: darwin, systemd: linux, schtasks: win32 };

function backendFor(target) {
  return BY_MANAGER[target?.manager] || null;
}

export { systemdEscape, xmlEscape };
export const CLI = fileURLToPath(new URL('../bin/marina.js', import.meta.url));
export const NODE = process.execPath;

export const idOf = (ctx) => `${ctx.key}:${ctx.major}`;

export function isEnabled(ctx) {
  return state.autostartList().includes(idOf(ctx));
}

export function unitTarget() {
  return host.unitTarget();
}

function requireUnitTarget() {
  const target = unitTarget();
  if (!target) throw new Error('autostart is not available on this host');
  return target;
}

export function renderUnit(ids, target = unitTarget()) {
  const backend = backendFor(target);
  if (!backend) throw new Error('autostart is not available on this host');
  const log = path.join(dirs.root, 'logs', 'autostart.log');
  return backend.renderUnit(ids, target, { node: NODE, cli: CLI, log, home: path.resolve(dirs.root) });
}

function run(cmd, args) {
  if (process.env.MARINA_NO_SERVICE === '1') return { ok: true, skipped: true };
  const res = spawnSync(cmd, args, { encoding: 'utf8' });
  return { ok: res.status === 0, stderr: (res.stderr || '').trim(), skipped: false };
}

function unload(target) {
  if (!fs.existsSync(target.file)) return [];
  const backend = backendFor(target);
  if (!backend) return [];
  return backend.unloadAutostart(target, run);
}

function load(target) {
  const backend = backendFor(target);
  if (!backend) return [];
  return backend.loadAutostart(target, run);
}

/**
 * Rewrite the OS hook to match state.settings.autostart.
 * @returns {{manager:string, file:string, ids:string[], enabled:boolean, warnings:string[]}}
 */
export function sync(target = requireUnitTarget()) {
  const ids = state.autostartList();
  if (!ids.length) {
    const results = unload(target);
    try {
      fs.rmSync(target.file, { force: true });
    } catch {}
    const warnings = results
      .filter((r) => r && !r.ok && !r.skipped)
      .map((r) => r.stderr || 'service manager returned an error');
    return { manager: target.manager, file: target.file, ids, enabled: false, warnings };
  }

  ensureDirs();
  fs.mkdirSync(target.dir, { recursive: true });
  const unit = renderUnit(ids, target);
  if (target.manager === 'schtasks') fs.writeFileSync(target.file, `\uFEFF${unit}`, 'utf16le');
  else fs.writeFileSync(target.file, unit);
  const results = load(target);
  const warnings = results
    .filter((r) => r && !r.ok && !r.skipped)
    .map((r) => r.stderr || 'service manager returned an error');
  return { manager: target.manager, file: target.file, ids, enabled: true, warnings };
}

export function enable(ctxs) {
  const target = requireUnitTarget();
  state.updateAutostart((ids) => [...ids, ...ctxs.map(idOf)]);
  return sync(target);
}

export function disable(ctxs) {
  const target = requireUnitTarget();
  const remove = new Set(ctxs.map(idOf));
  state.updateAutostart((ids) => ids.filter((id) => !remove.has(id)));
  return sync(target);
}

export function enableAll(ctxs) {
  return enable(ctxs);
}

export function disableAll() {
  const target = requireUnitTarget();
  state.setAutostart([]);
  return sync(target);
}

export function status() {
  const target = unitTarget();
  const ids = state.autostartList();
  return {
    supported: !!target,
    manager: target?.manager || null,
    file: target?.file || null,
    ids,
    installed: target ? fs.existsSync(target.file) : false,
  };
}
