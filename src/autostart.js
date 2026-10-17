// Login / boot autostart: one OS-level hook that starts the enabled databases.
// macOS -> LaunchAgent (runs at login), Linux -> systemd --user service.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirs, ensureDirs } from './paths.js';
import { IS_MAC, IS_LINUX } from './platform.js';
import * as state from './state.js';

const LABEL = 'com.marina.autostart';
const UNIT_NAME = 'marina-autostart.service';
export const CLI = fileURLToPath(new URL('../bin/marina.js', import.meta.url));
export const NODE = process.execPath;

export const idOf = (ctx) => `${ctx.key}:${ctx.major}`;

export function isEnabled(ctx) {
  return state.autostartList().includes(idOf(ctx));
}

export function unitTarget() {
  if (IS_MAC) {
    const dir = process.env.MARINA_LAUNCHD_DIR || path.join(os.homedir(), 'Library', 'LaunchAgents');
    return { manager: 'launchd', dir, file: path.join(dir, `${LABEL}.plist`) };
  }
  if (IS_LINUX) {
    const dir = process.env.MARINA_SYSTEMD_DIR || path.join(os.homedir(), '.config', 'systemd', 'user');
    return { manager: 'systemd', dir, file: path.join(dir, UNIT_NAME) };
  }
  return null;
}

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function renderUnit(ids, target = unitTarget()) {
  if (!target) throw new Error('autostart is only implemented for macOS and Linux');
  const log = path.join(dirs.root, 'logs', 'autostart.log');
  if (target.manager === 'launchd') {
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(NODE)}</string>
    <string>${xmlEscape(CLI)}</string>
    <string>start</string>
    <string>--autostart</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${xmlEscape(log)}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(log)}</string>
</dict>
</plist>
`;
  }
  return `[Unit]
Description=marina autostart databases (${ids.join(', ')})
After=network.target

[Service]
Type=oneshot
ExecStart="${NODE}" "${CLI}" start --autostart
RemainAfterExit=yes

[Install]
WantedBy=default.target
`;
}

function run(cmd, args) {
  if (process.env.MARINA_NO_SERVICE === '1') return { ok: true, skipped: true };
  const res = spawnSync(cmd, args, { encoding: 'utf8' });
  return { ok: res.status === 0, stderr: (res.stderr || '').trim(), skipped: false };
}

function unload(target) {
  if (!fs.existsSync(target.file)) return [];
  if (target.manager === 'launchd') {
    return [run('launchctl', ['bootout', `gui/${process.getuid()}`, target.file])];
  }
  return [run('systemctl', ['--user', 'disable', '--now', UNIT_NAME])];
}

function load(target) {
  if (target.manager === 'launchd') {
    const uid = `gui/${process.getuid()}`;
    unload(target);
    const res = run('launchctl', ['bootstrap', uid, target.file]);
    if (!res.ok) {
      const fallback = run('launchctl', ['load', '-w', target.file]);
      return [res, fallback];
    }
    return [res];
  }
  const reload = run('systemctl', ['--user', 'daemon-reload']);
  const enable = run('systemctl', ['--user', 'enable', '--now', UNIT_NAME]);
  return [reload, enable];
}

/**
 * Rewrite the OS hook to match state.settings.autostart.
 * @returns {{manager:string, file:string, ids:string[], enabled:boolean, warnings:string[]}}
 */
export function sync() {
  const target = unitTarget();
  if (!target) throw new Error('autostart is only implemented for macOS and Linux');

  const ids = state.autostartList();
  if (!ids.length) {
    unload(target);
    try {
      fs.rmSync(target.file, { force: true });
    } catch {}
    return { manager: target.manager, file: target.file, ids, enabled: false, warnings: [] };
  }

  ensureDirs();
  fs.mkdirSync(target.dir, { recursive: true });
  fs.writeFileSync(target.file, renderUnit(ids, target));
  const results = load(target);
  const warnings = results
    .filter((r) => r && !r.ok && !r.skipped)
    .map((r) => r.stderr || 'service manager returned an error');
  return { manager: target.manager, file: target.file, ids, enabled: true, warnings };
}

export function enable(ctxs) {
  const ids = [...state.autostartList(), ...ctxs.map(idOf)];
  state.setAutostart(ids);
  return sync();
}

export function disable(ctxs) {
  const remove = new Set(ctxs.map(idOf));
  state.setAutostart(state.autostartList().filter((id) => !remove.has(id)));
  return sync();
}

export function enableAll(ctxs) {
  state.setAutostart([...state.autostartList(), ...ctxs.map(idOf)]);
  return sync();
}

export function disableAll() {
  state.setAutostart([]);
  return sync();
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
