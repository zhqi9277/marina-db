// Host entry plans. The kernel is the platform's (WSL2, Lima, or Linux chroot).
// These functions only build argv; they do not start a VM.
export const DISTRO = 'marina';
export const AGENT_PORT = 4761;
export const DATA_ROOT = '/var/lib/marina';
export const APP_ROOT = '/opt/marina';

export function wslImport(rootfsTar, installDir) {
  return ['wsl.exe', '--import', DISTRO, installDir, rootfsTar, '--version', '2'];
}

export function wslExec(argv) {
  return ['wsl.exe', '-d', DISTRO, '--', ...argv];
}

export function limaStart(yaml) {
  return ['limactl', 'start', '--name=marina', yaml];
}

export function limaShell(argv) {
  return ['limactl', 'shell', DISTRO, ...argv];
}

export function chrootExec(rootfs, argv) {
  return ['chroot', rootfs, ...argv];
}

/** First process inside the rootfs. */
export function initArgv() {
  return [`${APP_ROOT}/bin/marina-init`];
}
