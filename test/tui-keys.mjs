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
    engine: {
      key,
      primaryClient: 'mysql',
      account: () => ({ user: 'root', password: 'root', mode: 'password' }),
    },
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

test('sidebar distinguishes downloaded and not-downloaded databases', () => {
  const screen = fakeScreen(100, 30);
  const app = new App(screen);
  const installed = fakeEngine('mysql', 'MySQL', 'running');
  const absent = {
    key: 'mariadb',
    label: 'MariaDB',
    version: null,
    major: '11.4',
    port: 3307,
    state: 'absent',
    installed: [],
    row: null,
    engine: { key: 'mariadb', primaryClient: 'mariadb' },
    ctx: null,
  };
  const downloaded = fakeEngine('redis', 'Redis', 'stopped');
  app.engines = [installed, downloaded, absent];
  app.render();
  const plain = screen.lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, '')).join('\n');
  const redisLine = screen.lines.find((l) => l.includes('Redis'));
  const mariaLine = screen.lines.find((l) => l.includes('MariaDB'));
  assert.match(redisLine, /\x1b\[38;5;173m/); // orange = downloaded
  assert.match(mariaLine, /\x1b\[38;5;179m/); // yellow arrow = not downloaded
  assert.match(plain, /MySQL\s+8\.4\.11/);
  assert.match(plain, /MariaDB\s+not inst\.\s+↓/);
  assert.doesNotMatch(plain, /MariaDB\s+not inst\.\s+↓\s+3307/); // no port for missing payload
});

test('title shows the orange logo and help shows the gitee address', () => {
  const screen = fakeScreen(100, 30);
  const app = new App(screen);
  app.engines = [fakeEngine('mysql', 'MySQL', 'running')];
  app.render();
  let plain = screen.lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, '')).join('\n');
  assert.match(plain, /🍊 marina 0\.1\.0/);

  app.mode = 'help';
  app.render();
  plain = screen.lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, '')).join('\n');
  assert.match(plain, /gitee\.com\/zhqi9277\/marina/);
});

test('port / user / password prompts edit and submit', async () => {
  const screen = fakeScreen(100, 30);
  const app = new App(screen);
  app.engines = [fakeEngine('mysql', 'MySQL', 'running')];
  app.refresh = async () => {};
  let submitted = null;
  app.openPrompt({
    title: 'MySQL port',
    label: 'port',
    value: '3306',
    onSubmit: async (v) => { submitted = v; return `port ${v} saved`; },
  });
  assert.equal(app.mode, 'prompt');

  await app.handle('ctrl-u');
  await app.handle('3');
  await app.handle('3');
  await app.handle('0');
  await app.handle('7');
  await app.handle('enter');

  assert.equal(submitted, '3307');
  assert.equal(app.mode, 'detail');
  assert.match(app.message.text, /3307/);
});

test('prompt esc cancels without submitting', async () => {
  const app = new App(fakeScreen());
  app.engines = [fakeEngine('mysql', 'MySQL', 'running')];
  let called = false;
  app.openPrompt({ title: 'x', label: 'x', value: '', onSubmit: async () => { called = true; } });
  await app.handle('esc');
  assert.equal(called, false);
  assert.equal(app.mode, 'detail');
});

test('actions menu exposes port / user / password', () => {
  const app = new App(fakeScreen());
  app.engines = [fakeEngine('mysql', 'MySQL', 'running')];
  const ids = app.actionsFor(app.engines[0]).map((a) => a.id);
  for (const id of ['port', 'user', 'password']) assert.ok(ids.includes(id));
});

test('spinner never renders undefined', () => {
  const screen = fakeScreen(100, 30);
  const app = new App(screen);
  app.busy = 'stopping mysql 8.4.11…';
  for (let i = 0; i < 12; i++) {
    app.spin = i;
    app.render();
    const plain = screen.lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, '')).join('\n');
    assert.doesNotMatch(plain, /undefined/);
  }
});

test('detail pane shows autostart state', () => {
  const screen = fakeScreen(100, 30);
  const app = new App(screen);
  app.engines = [fakeEngine('mysql', 'MySQL', 'running')];
  app.render();
  const plain = screen.lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, '')).join('\n');
  assert.match(plain, /autostart\s+(on|off)/);
});

test('detail pane shows account and password', () => {
  const screen = fakeScreen(100, 30);
  const app = new App(screen);
  app.engines = [fakeEngine('mysql', 'MySQL', 'running')];
  app.render();
  const plain = screen.lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, '')).join('\n');
  assert.match(plain, /account\s+root/);
  assert.match(plain, /password\s+root/);
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
  assert.ok(ids.includes('reconfig'));
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
  const screen = fakeScreen();
  const app = new App(screen);
  app.engines = [fakeEngine('mysql', 'MySQL', 'running')];
  app.mode = 'versions';
  app.versionSel = 0;
  app.remote = {
    loading: false,
    source: 'fixture',
    versions: [{ version: '8.0.29', kind: 'binary', source: 'huawei', supported: true, urls: ['u'] }],
  };
  app.render(); // populates versionItems
  const raw = screen.lines.join('\n');
  assert.match(raw, /◉/); // installed version
  assert.match(raw, /↓/); // downloadable version

  await app.handle('esc:B');
  assert.equal(app.versionSel, 1);
  await app.handle('esc:A');
  assert.equal(app.versionSel, 0);
});
