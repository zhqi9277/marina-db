// Databases install inside the Linux that boots marina's kernel.
// The host only starts that guest and forwards commands to marina-agent.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const AGENT_PORT = 4761;
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const FORWARDED = [4761, 3306, 3307, 5432, 27017, 6379, 11211];
const LOCAL = new Set(['help', '--help', '-h', 'version', '--version']);

export function inGuest() {
  return process.env.MARINA_INSIDE_LINUX === '1';
}

export function rootfsImage(root = REPO_ROOT) {
  return path.join(root, 'dist', 'rootfs.img');
}

export function guestReady(root = REPO_ROOT) {
  const kernelDir = path.join(root, 'dist', 'kernel');
  return fs.existsSync(rootfsImage(root)) && (fs.existsSync(path.join(kernelDir, 'Image')) || fs.existsSync(path.join(kernelDir, 'bzImage')));
}

export function qemuBinary(arch) {
  return arch === 'x64' || arch === 'x86_64' ? 'qemu-system-x86_64' : 'qemu-system-aarch64';
}

/** argv that boots dist/kernel on dist/rootfs.img. Databases are installed in that guest. */
export function qemuArgv({ root = REPO_ROOT, arch = process.arch, platform = process.platform } = {}) {
  const arm = arch !== 'x64' && arch !== 'x86_64';
  const kernel = path.join(root, 'dist', 'kernel', arm ? 'Image' : 'bzImage');
  const disk = rootfsImage(root);
  const base = fs.readFileSync(path.join(root, 'runtime-os', 'kernel', 'cmdline'), 'utf8').trim();
  const accel = platform === 'linux' ? 'kvm' : platform === 'darwin' ? 'hvf' : 'tcg';
  const machine = arm ? `virt,accel=${accel}` : `q35,accel=${accel}`;
  const fwds = FORWARDED.map((port) => `hostfwd=tcp:127.0.0.1:${port}-:${port}`).join(',');
  return [
    qemuBinary(arch),
    '-machine', machine,
    '-cpu', accel === 'tcg' ? 'max' : 'host',
    '-smp', '4',
    '-m', '2048',
    '-nographic',
    '-kernel', kernel,
    '-append', `${base} console=${arm ? 'ttyAMA0' : 'ttyS0'} marina.epoch=${Math.floor(Date.now() / 1000)}`,
    // virtio-mmio. The tiny kernel has no PCI host bridge, so if=virtio never appears as /dev/vda.
    '-drive', `file=${disk},if=none,format=raw,id=rootdisk`,
    '-device', 'virtio-blk-device,drive=rootdisk',
    '-netdev', `user,id=n0,${fwds}`,
    '-device', 'virtio-net-device,netdev=n0',
  ];
}

async function agentUp(port) {
  try {
    const result = await callAgent('ping', {}, { port, timeout: 700 });
    return result?.ok === true || result === 'pong' || result != null;
  } catch {
    return false;
  }
}

export function callAgent(method, params, { port = AGENT_PORT, timeout = 620000 } = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error('guest agent timed out'));
    }, timeout);
    const fail = (err) => {
      clearTimeout(timer);
      reject(err);
    };
    sock.once('error', fail);
    let buf = '';
    sock.on('connect', () => sock.write(`${JSON.stringify({ id: 1, method, params })}\n`));
    sock.on('data', (chunk) => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      clearTimeout(timer);
      sock.end();
      let msg;
      try {
        msg = JSON.parse(buf.slice(0, nl));
      } catch (err) {
        fail(err);
        return;
      }
      if (msg.error) fail(new Error(msg.error));
      else resolve(msg.result);
    });
  });
}

let booting = null;

export function ensureGuest(root = REPO_ROOT) {
  if (!guestReady(root)) {
    throw new Error('kernel guest is not built — run scripts/build-rootfs.sh, then boot dist/kernel on dist/rootfs.img');
  }
  if (booting) return booting;
  booting = (async () => {
    if (await agentUp(AGENT_PORT)) return;
    const logFd = fs.openSync(path.join(root, 'dist', 'guest.log'), 'w');
    const argv = qemuArgv({ root });
    const child = spawn(argv[0], argv.slice(1), { detached: true, stdio: ['ignore', logFd, logFd] });
    fs.writeFileSync(path.join(root, 'dist', 'guest.pid'), `${child.pid}\n`);
    child.unref();
    const until = Date.now() + 45000;
    while (Date.now() < until) {
      if (await agentUp(AGENT_PORT)) return;
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    try {
      process.kill(child.pid, 'SIGTERM');
    } catch {
      // already gone
    }
    throw new Error('guest kernel did not open the agent on 127.0.0.1:4761 — see dist/guest.log');
  })().finally(() => {
    booting = null;
  });
  return booting;
}

/**
 * Run this marina command inside the kernel guest. Returns null when the
 * command stays on the host (help, native override, or the guest image is absent).
 */
export async function maybeEnterGuest(argv, root = REPO_ROOT) {
  if (inGuest() || process.env.MARINA_NATIVE === '1') return null;
  const command = argv.find((arg) => !arg.startsWith('-'));
  if (!command || LOCAL.has(command)) return null;
  if (!guestReady(root)) return null;
  await ensureGuest(root);
  const result = await callAgent('exec', {
    argv: ['/opt/marina/bin/marina', ...argv],
    dir: '/var/lib/marina',
    timeout: 600,
  });
  if (result?.stdout) process.stdout.write(result.stdout);
  if (result?.stderr) process.stderr.write(result.stderr);
  return Number.isInteger(result?.code) ? result.code : 1;
}
