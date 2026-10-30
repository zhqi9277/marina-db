// Linux host: /proc identity, POSIX signals, systemd --user login autostart.
import os from 'node:os';
import path from 'node:path';
import { defineHost } from './define.js';
import { systemdEscape } from './escape.js';
import { linkDir, linkFile } from './fs.js';
import { POSIX_STOP, posixProcessDetails, posixShellenv, posixShimScript, signalTerminate } from './posix.js';

const UNIT_NAME = 'marina-autostart.service';

export const linux = defineHost({
  id: 'linux',
  label: 'Linux',
  unixSocket: true,
  fork: true,
  posixSignals: true,
  exe: (name) => name,
  libInspector: () => ({ cmd: 'ldd', args: [] }),
  linkDir: (target, link) => linkDir(target, link, 'dir'),
  linkFile,
  processDetails: (pid) => posixProcessDetails(pid, { proc: true }),
  terminate: signalTerminate,
  forceVerb: POSIX_STOP.forceVerb,
  killHint: POSIX_STOP.killHint,
  shimFileName: (bin) => bin,
  shimScript: posixShimScript,
  shellenv: posixShellenv,
  unitTarget() {
    const dir = process.env.MARINA_SYSTEMD_DIR || path.join(os.homedir(), '.config', 'systemd', 'user');
    return { manager: 'systemd', dir, file: path.join(dir, UNIT_NAME), unitName: UNIT_NAME };
  },
  renderUnit(ids, _target, { node, cli }) {
    return `[Unit]
Description=marina autostart databases (${ids.join(', ')})
After=network.target

[Service]
Type=oneshot
ExecStart="${systemdEscape(node)}" "${systemdEscape(cli)}" start --autostart
RemainAfterExit=yes

[Install]
WantedBy=default.target
`;
  },
  loadAutostart(target, run) {
    const name = target.unitName || UNIT_NAME;
    const reload = run('systemctl', ['--user', 'daemon-reload']);
    const enable = run('systemctl', ['--user', 'enable', '--now', name]);
    return [reload, enable];
  },
  unloadAutostart(target, run) {
    const name = target.unitName || UNIT_NAME;
    return [run('systemctl', ['--user', 'disable', '--now', name])];
  },
});
