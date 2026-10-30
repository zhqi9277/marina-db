// macOS host: ps/lsof identity, POSIX signals, LaunchAgent at login.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defineHost } from './define.js';
import { xmlEscape } from './escape.js';
import { linkDir, linkFile } from './fs.js';
import { POSIX_STOP, posixProcessDetails, posixShellenv, posixShimScript, signalTerminate } from './posix.js';

const LABEL = 'com.marina.autostart';

export const darwin = defineHost({
  id: 'darwin',
  label: 'macOS',
  unixSocket: true,
  fork: true,
  posixSignals: true,
  exe: (name) => name,
  libInspector: () => ({ cmd: 'otool', args: ['-L'] }),
  linkDir: (target, link) => linkDir(target, link, 'dir'),
  linkFile,
  processDetails: (pid) => posixProcessDetails(pid),
  terminate: signalTerminate,
  forceVerb: POSIX_STOP.forceVerb,
  killHint: POSIX_STOP.killHint,
  shimFileName: (bin) => bin,
  shimScript: posixShimScript,
  shellenv: posixShellenv,
  unitTarget() {
    const dir = process.env.MARINA_LAUNCHD_DIR || path.join(os.homedir(), 'Library', 'LaunchAgents');
    return { manager: 'launchd', dir, file: path.join(dir, `${LABEL}.plist`) };
  },
  renderUnit(_ids, _target, { node, cli, log }) {
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(node)}</string>
    <string>${xmlEscape(cli)}</string>
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
  },
  loadAutostart(target, run) {
    const uid = `gui/${process.getuid()}`;
    if (fs.existsSync(target.file)) this.unloadAutostart(target, run);
    const res = run('launchctl', ['bootstrap', uid, target.file]);
    if (!res.ok) {
      const fallback = run('launchctl', ['load', '-w', target.file]);
      return [res, fallback];
    }
    return [res];
  },
  unloadAutostart(target, run) {
    // `bootout` is the modern verb, but it does not exist on older macOS: fall
    // back to `unload -w`, otherwise disabling autostart leaves the job loaded
    // and it comes back at the next login
    const res = run('launchctl', ['bootout', `gui/${process.getuid()}`, target.file]);
    if (res.ok || res.skipped) return [res];
    const fallback = run('launchctl', ['unload', '-w', target.file]);
    return fallback.ok || fallback.skipped ? [fallback] : [res, fallback];
  },
});
