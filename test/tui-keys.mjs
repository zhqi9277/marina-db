// Regression tests for raw key names and TUI arrow navigation.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readKeys } from '../src/tui/screen.js';
import { App } from '../src/tui/app.js';

function fakeScreen(cols = 100, rows = 30) {
  return { cols, rows, lines: [], onResize: null, draw(l) { this.lines = l; } };
}

function fakeEngine(key, label, state) {
  return {
    key,
    label,
    version: '8.4.11',
    major: '8.4',
    port: 3306,
    state,
    installed: ['8.4.11'],
    row: { version: '8.4.11', active: true },
    engine: { key, primaryClient: 'mysql' },
    ctx: { versionDir: '/x', dataDir: '/y', confFile: '/z', logFile: '/l' },
  };
}

test('readKeys emits the key names the app compares against', () => {
  const keys = [];
  const off = readKeys((k) => keys.push(k));
  for (const s of ['\x1b[A', '\x1b[B', '\x1b[C', '\r', 'j', 'k', '?', 'q']) {
    process.stdin.emit('data', Buffer.from(s));
  }
  off();
  process.stdin.pause();
  process.stdin.unref?.();
  assert.deepEqual(keys, ['esc:A', 'esc:B', 'esc:C', 'enter', 'j', 'k', '?', 'q']);
});

test('arrow keys move the database selection', async () => {
  const app = new App(fakeScreen());
  app.engines = [fakeEngine('mysql', 'MySQL', 'running'), fakeEngine('redis', 'Redis', 'stopped')];
  app.sel = 0;

  await app.handle('esc:B');
  assert.equal(app.sel, 1);
  await app.handle('esc:A');
  assert.equal(app.sel, 0);
  await app.handle('j');
  assert.equal(app.sel, 1);
});

test('enter on the dashboard skips disabled actions', async () => {
  const app = new App(fakeScreen());
  app.engines = [fakeEngine('mysql', 'MySQL', 'running')];
  app.sel = 0;

  await app.handle('enter');
  assert.equal(app.mode, 'actions');
  // running -> Start is disabled, so the cursor lands on Stop (index 1)
  assert.equal(app.actionSel, 1);

  await app.handle('esc:B');
  assert.equal(app.actionSel, 2);
  await app.handle('esc:A');
  assert.equal(app.actionSel, 1);
});

test('d opens the doctor view and loads checks', async () => {
  const app = new App(fakeScreen());
  app.engines = [fakeEngine('mysql', 'MySQL', 'running')];
  await app.handle('d');
  assert.equal(app.mode, 'doctor');
  assert.ok(Array.isArray(app.doctor));
  assert.ok(app.doctor.length >= 6);
});

test('actions menu exposes start all / stop all / doctor', () => {
  const app = new App(fakeScreen());
  app.engines = [fakeEngine('mysql', 'MySQL', 'running'), fakeEngine('redis', 'Redis', 'stopped')];
  const actions = app.actionsFor(app.engines[0]);
  const ids = actions.map((a) => a.id);
  assert.ok(ids.includes('startAll'));
  assert.ok(ids.includes('stopAll'));
  assert.ok(ids.includes('doctor'));
  assert.equal(actions.find((a) => a.id === 'startAll').enabled, true); // redis is stopped
  assert.equal(actions.find((a) => a.id === 'stopAll').enabled, true); // mysql is running
});

test('doctor view renders every check with the right width', () => {
  const screen = fakeScreen(100, 30);
  const app = new App(screen);
  app.engines = [fakeEngine('mysql', 'MySQL', 'running')];
  app.mode = 'doctor';
  app.doctor = [
    { name: 'platform', value: 'macOS arm64', ok: true },
    { name: 'libs', value: 'all engine dylibs resolve (6 checked)', ok: true },
    { name: 'ports', value: 'mysql port 3306', ok: false },
  ];
  app.render();
  const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
  assert.equal(screen.lines.length, 30);
  for (const line of screen.lines) assert.equal(strip(line).length, 100);
  assert.ok(screen.lines.some((l) => strip(l).includes('platform')));
  assert.ok(screen.lines.some((l) => strip(l).includes('fail')));
});

test('arrow keys move the version list selection', async () => {
  const app = new App(fakeScreen());
  app.engines = [fakeEngine('mysql', 'MySQL', 'running')];
  app.mode = 'versions';
  app.versionSel = 0;
  app.remote = {
    loading: false,
    source: 'fixture',
    versions: [{ version: '8.0.29', kind: 'binary', source: 'huawei', supported: true, urls: ['u'] }],
  };
  app.render(); // populates versionItems

  await app.handle('esc:B');
  assert.equal(app.versionSel, 1);
  await app.handle('esc:A');
  assert.equal(app.versionSel, 0);
});
