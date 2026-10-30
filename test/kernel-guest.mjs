// Host qemu arguments for booting marina's kernel. Nothing is executed.
import assert from 'node:assert/strict';
import test from 'node:test';
import { qemuArgv, guestReady, inGuest } from '../src/kernel-guest.js';

test('qemu boots the marina kernel and forwards database ports', () => {
  const argv = qemuArgv({ arch: 'arm64', platform: 'darwin' });
  assert.equal(argv[0], 'qemu-system-aarch64');
  assert.ok(argv.includes('virt,accel=hvf'));
  const append = argv[argv.indexOf('-append') + 1];
  assert.match(append, /init=\/opt\/marina\/bin\/marina-init/);
  assert.match(append, /root=\/dev\/vda/);
  assert.match(append, /console=ttyAMA0/);
  assert.match(append, /marina\.epoch=\d+/);
  assert.ok(argv.includes('virtio-blk-device,drive=rootdisk'));
  const netdev = argv[argv.indexOf('-netdev') + 1];
  for (const port of [4761, 3306, 5432, 6379]) {
    assert.match(netdev, new RegExp(`hostfwd=tcp:127\\.0\\.0\\.1:${port}-:${port}`));
  }
  assert.equal(argv.includes('pci=off'), false);
});

test('guest entry stays on the host until a rootfs image exists', () => {
  assert.equal(inGuest(), false);
  assert.equal(guestReady('/no/such/marina'), false);
});
