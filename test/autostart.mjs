// OS hook rendering (no launchctl/systemctl, no filesystem writes).
import assert from 'node:assert/strict';
import test from 'node:test';
import { renderUnit, CLI, NODE } from '../src/autostart.js';

test('launchd unit runs marina start --autostart', () => {
  const xml = renderUnit(['mysql:8.4'], { manager: 'launchd', dir: '/tmp', file: '/tmp/x.plist' });
  assert.match(xml, /com\.marina\.autostart/);
  assert.ok(xml.includes(CLI));
  assert.ok(xml.includes(NODE));
  assert.match(xml, /<string>--autostart<\/string>/);
  assert.match(xml, /<key>RunAtLoad<\/key><true\/>/);
});

test('systemd unit runs marina start --autostart', () => {
  const unit = renderUnit(['redis:7'], { manager: 'systemd', dir: '/tmp', file: '/tmp/x.service' });
  assert.match(unit, /ExecStart=.*start --autostart/);
  assert.match(unit, /WantedBy=default\.target/);
});

test('unknown manager is rejected', () => {
  assert.throws(() => renderUnit([], null), /macOS and Linux/);
});
