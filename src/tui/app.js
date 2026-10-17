// Full-screen interactive dashboard: two panes, live status,
// keyboard driven, no deps.
import fs from 'node:fs';
import path from 'node:path';
import { Screen, readKeys } from './screen.js';
import {
  C, vlen, fit, bottom, rule, row, fullRow, badge, dot, keysBar, shortPath, truncMid, kv,
} from './draw.js';
import { collectEngines } from '../inventory.js';
import { start, stop, restart } from '../lifecycle.js';
import { install, use } from '../installer.js';
import { listVersions } from '../versions.js';
import { HOME, PROJECT_ROOT } from '../paths.js';
import { OS_LABEL } from '../platform.js';
import { setQuiet } from '../ui.js';

const VERSION = '0.1.0';

function titleBar(W, left, right) {
  const inner = W - 2;
  const l = ` ${left} `;
  const r = right ? ` ${right} ` : '';
  const fill = Math.max(0, inner - vlen(l) - vlen(r) - 2);
  return C.border('╭─') + l + C.border('─'.repeat(fill)) + r + C.border('─╮');
}

function panelTitle(text, width) {
  return `${C.bold(text)}${C.gray(' ' + '─'.repeat(Math.max(0, width - vlen(text) - 1)))}`;
}

export class App {
  constructor(screen) {
    this.screen = screen;
    this.mode = 'detail'; // detail | actions | versions | logs | help
    this.sel = 0;
    this.actionSel = 0;
    this.versionSel = 0;
    this.engines = [];
    this.message = { kind: 'info', text: 'ready' };
    this.busy = null;
    this.spin = 0;
    this.logs = [];
    this.logScroll = 0;
    this.remote = null; // { majors: [...] } | null
    this.renderQueued = false;
    this.done = false;
  }

  // ---------------------------------------------------------------- data --
  async refresh() {
    if (this.busy) return;
    try {
      this.engines = await collectEngines();
    } catch (e) {
      this.message = { kind: 'err', text: e.message.split('\n')[0] };
    }
    this.sel = Math.max(0, Math.min(this.sel, this.engines.length - 1));
    this.render();
  }

  current() {
    return this.engines[this.sel] || null;
  }

  async run(label, fn) {
    this.busy = label;
    this.message = { kind: 'info', text: label };
    setQuiet(true);
    this.startSpin();
    this.render();
    try {
      await fn();
      this.message = { kind: 'ok', text: `${label.replace(/\s*…$/, '')} done` };
    } catch (e) {
      this.message = { kind: 'err', text: String(e.message || e).split('\n')[0] };
    } finally {
      setQuiet(false);
      this.busy = null;
      this.stopSpin();
      await this.refresh();
    }
  }

  startSpin() {
    this.stopSpin();
    this.spinTimer = setInterval(() => {
      this.spin = (this.spin + 1) % 10;
      this.render();
    }, 90);
  }

  stopSpin() {
    if (this.spinTimer) clearInterval(this.spinTimer);
    this.spinTimer = null;
  }

  // -------------------------------------------------------------- render --
  render() {
    const W = this.screen.cols;
    const H = this.screen.rows;
    if (W < 64 || H < 16) {
      const msg = 'terminal too small — resize to at least 64x16';
      this.screen.draw(
        Array.from({ length: H }, (_, i) =>
          i === Math.floor(H / 2) ? C.yellow(fit(msg, W, 'left')) : ' '.repeat(W),
        ),
      );
      return;
    }

    const innerW = W - 2;
    const leftW = Math.max(26, Math.min(38, Math.floor(innerW * 0.4)));
    const rightW = innerW - leftW - 1;
    const bodyH = H - 7;
    const full = this.mode === 'logs' || this.mode === 'help';

    const lines = [];
    const homeLabel = HOME === path.join(PROJECT_ROOT, 'runtime')
      ? 'runtime/'
      : shortPath(HOME, Math.min(34, W - 34), HOME);
    const meta = `${this.engines.filter((e) => e.state !== 'absent').length} installed · ${homeLabel}`;
    lines.push(titleBar(W, `${C.bold('marina')} ${C.gray(VERSION)}`, C.gray(meta)));

    // column headers
    if (full) {
      const title = this.mode === 'logs' ? `LOGS ${this.headerLabel()}` : 'KEYS';
      lines.push(fullRow(W, ` ${C.gray(title)}`));
      lines.push(rule(innerW, { left: '├', fill: '─', right: '┤' }));
    } else {
      lines.push(row(leftW, rightW, ` ${C.gray('DATABASES')}`, ` ${C.gray(this.paneLabel())}`));
      lines.push(rule(innerW, { left: '├', mid: '┴', right: '┤', at: leftW }));
    }

    const body = full ? this.renderFull(innerW, bodyH) : this.renderSplit(leftW, rightW, bodyH);
    for (const line of body) lines.push(line);

    lines.push(full ? rule(innerW, { left: '├', fill: '─', right: '┤' }) : rule(innerW, { left: '├', mid: '┴', right: '┤', at: leftW }));
    lines.push(fullRow(W, ` ${this.renderKeys(innerW - 2)}`));
    lines.push(fullRow(W, ` ${this.renderMessage()}`));
    lines.push(bottom(W));

    this.screen.draw(lines.slice(0, H));
  }

  paneLabel() {
    switch (this.mode) {
      case 'actions': return 'ACTIONS';
      case 'versions': return 'VERSIONS';
      default: return 'DETAIL';
    }
  }

  headerLabel() {
    const e = this.current();
    return e && e.version ? `${e.label} ${e.version}` : '';
  }

  renderSplit(leftW, rightW, bodyH) {
    const left = [];
    for (let i = 0; i < bodyH; i++) {
      const e = this.engines[i];
      if (!e) {
        left.push(' ');
        continue;
      }
      const selected = i === this.sel;
      const port = e.state === 'absent' ? '' : String(e.port);
      const marker = selected ? '▸ ' : '  ';
      const label = fit(e.label, 11);
      const ver = fit(e.version || '—', 9);
      const mark = e.state === 'running' ? '●' : e.state === 'degraded' ? '◐' : e.state === 'absent' ? '·' : '○';
      const plain = `${marker}${label}${ver}${mark} ${port.padStart(5)}`;
      if (selected) left.push(C.bg(236, C.fg(255, fit(plain, leftW))));
      else left.push(fit(`  ${C.gray(label)}${C.fg(250, ver)}${dot(e.state)} ${C.gray(port.padStart(5))}`, leftW));
    }

    const right = this.mode === 'actions'
      ? this.renderActions(rightW, bodyH)
      : this.mode === 'versions'
        ? this.renderVersions(rightW, bodyH)
        : this.renderDetail(rightW, bodyH);

    const out = [];
    for (let i = 0; i < bodyH; i++) out.push(row(leftW, rightW, left[i] || ' ', right[i] || ' '));
    return out;
  }

  renderDetail(w, h) {
    const e = this.current();
    const lines = [];
    if (!e) return lines;
    const pad = w - 2;

    lines.push(` ${C.bold(e.label)} ${e.version ? C.gray(e.version) : ''}`.slice(0, 400));
    lines.push(` ${C.gray('─'.repeat(Math.max(0, pad - 1)))}`);

    if (e.state === 'absent') {
      lines.push(` ${C.gray('not installed yet')}`);
      lines.push('');
      lines.push(` ${C.gray('press')} ${C.accent('v')} ${C.gray('to browse versions and install')}`);
      return lines.slice(0, h);
    }

    const ctx = e.ctx;
    const rows = [
      ['state', badge(e.state)],
      ['port', C.fg(250, `127.0.0.1:${e.port}`)],
      ['pid', C.fg(250, e.pid ? String(e.pid) : '—')],
      ['active', e.row?.active ? C.accent('yes') : C.gray('no')],
      ['versions', C.fg(250, e.installed.join(', '))],
      ['payload', C.gray(relTo(ctx.versionDir, pad - 10))],
      ['data', C.gray(relTo(ctx.dataDir, pad - 10))],
      ['config', C.gray(ctx.confFile ? relTo(ctx.confFile, pad - 10) : '—')],
      ['log', C.gray(relTo(ctx.logFile, pad - 10))],
    ];
    for (const [k, v] of rows) lines.push(` ${kv(k, v, 9)}`);
    lines.push('');
    lines.push(` ${C.gray('client')} ${C.accent(`marina exec ${e.key}@${e.major}`)}`);
    return lines.slice(0, h).map((l) => fit(l, w));
  }

  actionsFor(e) {
    const running = e.state === 'running' || e.state === 'degraded';
    const installed = e.state !== 'absent';
    return [
      { id: 'start', label: 'Start', enabled: installed && !running },
      { id: 'stop', label: 'Stop', enabled: installed && running },
      { id: 'restart', label: 'Restart', enabled: installed },
      { id: 'logs', label: 'Show logs', enabled: installed },
      { id: 'versions', label: 'Versions / install', enabled: true },
      { id: 'config', label: 'Config path', enabled: installed },
      { id: 'client', label: 'Copy client command', enabled: installed },
      { id: 'back', label: 'Back', enabled: true },
    ];
  }

  renderActions(w, h) {
    const e = this.current();
    const lines = [];
    if (!e) return lines;
    lines.push(` ${panelTitle(`${e.label} ${e.version || ''}`, w - 2)}`);
    const actions = this.actionsFor(e);
    this.actionSel = Math.max(0, Math.min(this.actionSel, actions.length - 1));
    for (let i = 0; i < actions.length; i++) {
      const a = actions[i];
      const selected = i === this.actionSel;
      const text = ` ${selected ? '▸' : ' '} ${a.label}`;
      let cell;
      if (!a.enabled) cell = C.grayDark(text);
      else if (selected) cell = C.bg(236, C.fg(255, fit(text, w - 2)));
      else cell = C.fg(250, text);
      lines.push(fit(cell, w));
    }
    lines.push('');
    lines.push(` ${C.gray('↑↓ choose · enter run · esc back')}`);
    return lines.slice(0, h);
  }

  async loadRemote(refresh = false) {
    if (this.remote && !refresh) return;
    this.remote = { loading: true, versions: [] };
    this.render();
    try {
      const e = this.current();
      const idx = await listVersions(e.key, { refresh });
      this.remote = { loading: false, ...idx };
    } catch (err) {
      this.remote = { loading: false, versions: [], error: err.message.split('\n')[0] };
    }
    this.render();
  }

  renderVersions(w, h) {
    const e = this.current();
    if (!e) return [];
    const installed = e.installed || [];
    const activeVersion = e.row?.version;
    const items = [];
    for (const v of installed) {
      items.push({ type: 'installed', version: v, active: v === activeVersion });
    }
    if (this.remote && !this.remote.loading && !this.remote.error) {
      for (const v of this.remote.versions || []) {
        if (!installed.includes(v.version)) items.push({ type: 'remote', version: v.version, entry: v });
      }
    }
    this.versionItems = items;
    this.versionSel = Math.max(0, Math.min(this.versionSel || 0, Math.max(0, items.length - 1)));

    const lines = [];
    lines.push(` ${panelTitle(`${e.label} versions`, w - 2)}`);
    if (!this.remote || this.remote.loading) {
      lines.push(` ${C.gray('loading remote index…')}`);
    } else if (this.remote.error) {
      lines.push(` ${C.yellow('index unavailable')}`);
      lines.push(` ${C.gray(truncLine(this.remote.error, w - 4))}`);
    } else {
      lines.push(` ${C.gray(`${this.remote.versions.length} versions · index: ${this.remote.source}`)}`);
    }

    const viewH = Math.max(1, h - lines.length - 2);
    const start = Math.max(0, Math.min(this.versionSel - Math.floor(viewH / 2), items.length - viewH));
    let i = start;
    for (const it of items.slice(start, start + viewH)) {
      const selected = i === this.versionSel;
      let text;
      if (it.type === 'installed') {
        text = ` ${selected ? '▸' : ' '} ◉ ${fit(it.version, 11)}${it.active ? C.gray('active') : ''}`;
      } else {
        const v = it.entry;
        const note = v.supported ? `${v.kind} · ${v.source}` : `n/a on ${OS_LABEL}`;
        text = ` ${selected ? '▸' : ' '} + ${fit(it.version, 11)}${C.gray(note)}`;
      }
      lines.push(fit(selected ? C.bg(236, C.fg(255, text)) : C.fg(250, text), w));
      i++;
    }
    while (lines.length < h - 1) lines.push(fit(' ', w));
    lines.push(` ${C.gray('↑↓ choose · enter activate/install · g refresh · esc back')}`);
    return lines.slice(0, h);
  }

  renderFull(w, h) {
    if (this.mode === 'help') return this.renderHelp(w, h);
    return this.renderLogs(w, h);
  }

  renderHelp(w, h) {
    const rows = [
      ['↑ ↓ / j k', 'move selection'],
      ['enter', 'actions for the selected database'],
      ['s / x / r', 'start / stop / restart'],
      ['v', 'versions: activate installed, install new major'],
      ['l', 'logs (↑↓ scroll, pgup/pgdn, esc back)'],
      ['c', 'print config path'],
      ['y', 'print client command'],
      ['g', 'refresh now'],
      ['1…6', 'jump to database'],
      ['q', 'quit'],
    ];
    const lines = [];
    lines.push(` ${panelTitle('keyboard', w - 2)}`);
    for (const [k, v] of rows) {
      lines.push(`  ${C.fg(252, C.bg(238, ` ${fit(k, 12)} `))}  ${C.fg(250, v)}`);
    }
    lines.push('');
    lines.push(` ${C.gray('marina is local only: no root, no launchd, everything lives under')} ${C.accent(shortPath(HOME, 40, HOME))}`);
    return lines.slice(0, h).map((l) => fit(l, w));
  }

  renderLogs(w, h) {
    const e = this.current();
    const lines = [];
    if (!e || e.state === 'absent') {
      lines.push(` ${C.gray('nothing installed for this database')}`);
      return lines.slice(0, h).map((l) => fit(l, w));
    }
    const ctx = e.ctx;
    const viewH = h - 2;
    const start = Math.max(0, this.logs.length - viewH - this.logScroll);
    const slice = this.logs.slice(start, start + viewH);
    for (const l of slice) lines.push(fit(` ${l}`, w));
    while (lines.length < viewH) lines.push(fit(' ', w));
    lines.push(fit(` ${C.gray(shortPath(ctx.logFile, w - 4, HOME))}`, w));
    lines.push(fit(` ${C.gray(`${this.logs.length} lines · ↑↓ scroll · r reload · esc back`)}`, w));
    return lines;
  }

  renderKeys(w) {
    if (this.mode === 'actions') return keysBar([['↑↓', 'choose'], ['enter', 'run'], ['esc', 'back'], ['q', 'quit']], w);
    if (this.mode === 'versions') return keysBar([['↑↓', 'choose'], ['enter', 'select'], ['esc', 'back'], ['q', 'quit']], w);
    if (this.mode === 'logs') return keysBar([['↑↓', 'scroll'], ['r', 'reload'], ['esc', 'back'], ['q', 'quit']], w);
    if (this.mode === 'help') return keysBar([['esc', 'back'], ['q', 'quit']], w);
    return keysBar(
      [['↑↓', 'move'], ['enter', 'actions'], ['s', 'start'], ['x', 'stop'], ['r', 'restart'], ['v', 'versions'], ['l', 'logs'], ['?', 'keys'], ['q', 'quit']],
      w,
    );
  }

  renderMessage() {
    const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    if (this.busy) return `${C.accent(frames[this.spin])} ${C.fg(250, this.busy)}`;
    const m = this.message || {};
    const text = m.text || '';
    if (m.kind === 'ok') return `${C.green('✓')} ${C.fg(250, text)}`;
    if (m.kind === 'err') return `${C.red('✗')} ${C.red(text)}`;
    return `${C.gray('·')} ${C.gray(text)}`;
  }

  // ---------------------------------------------------------------- keys --
  async handle(key) {
    if (this.busy) {
      if (key === 'ctrl-c') this.done = true;
      return;
    }
    if (key === 'ctrl-c') {
      this.done = true;
      return;
    }

    if (this.mode === 'help') {
      if (key === 'esc' || key === '?' || key === 'q') this.mode = 'detail';
      this.render();
      return;
    }

    if (this.mode === 'logs') return this.handleLogs(key);
    if (this.mode === 'actions') return this.handleActions(key);
    if (this.mode === 'versions') return this.handleVersions(key);

    // dashboard
    if (key === 'q') {
      this.done = true;
      return;
    }
    if (key === '?') {
      this.mode = 'help';
      this.render();
      return;
    }
    if (key === 'esc: A' || key === 'k') {
      this.sel = (this.sel + this.engines.length - 1) % Math.max(1, this.engines.length);
      this.render();
      return;
    }
    if (key === 'esc: B' || key === 'j') {
      this.sel = (this.sel + 1) % Math.max(1, this.engines.length);
      this.render();
      return;
    }
    const digit = Number(key);
    if (Number.isInteger(digit) && digit >= 1 && digit <= this.engines.length) {
      this.sel = digit - 1;
      this.render();
      return;
    }
    if (key === 'enter' || key === 'esc: C') {
      this.mode = 'actions';
      this.actionSel = 0;
      this.render();
      return;
    }
    if (key === 's') return this.quick('start');
    if (key === 'x') return this.quick('stop');
    if (key === 'r') return this.quick('restart');
    if (key === 'l') return this.openLogs();
    if (key === 'v') {
      this.mode = 'versions';
      this.versionSel = 0;
      this.remote = null;
      this.render();
      this.loadRemote();
      return;
    }
    if (key === 'c' || key === 'y') {
      const e = this.current();
      if (!e || e.state === 'absent') return;
      const text = key === 'c'
        ? (e.ctx.confFile || `${e.label} has no marina-managed config`)
        : `marina exec ${e.key}@${e.major} -- ${e.engine.primaryClient}`;
      this.message = { kind: 'ok', text };
      this.render();
      return;
    }
    if (key === 'g') {
      this.message = { kind: 'info', text: 'refreshing…' };
      await this.refresh();
    }
  }

  async quick(action) {
    const e = this.current();
    if (!e || e.state === 'absent') {
      this.message = { kind: 'err', text: `${e?.label || 'database'} is not installed` };
      return this.render();
    }
    const ctx = e.ctx;
    const label = { start: 'starting', stop: 'stopping', restart: 'restarting' }[action];
    await this.run(`${label} ${e.key} ${e.version}…`, async () => {
      if (action === 'start') await start(ctx, { quiet: true });
      else if (action === 'stop') await stop(ctx, { quiet: true });
      else await restart(ctx, { quiet: true });
    });
  }

  async openLogs() {
    const e = this.current();
    if (!e || e.state === 'absent') return;
    this.mode = 'logs';
    this.logScroll = 0;
    this.loadLogs();
    this.render();
  }

  loadLogs() {
    const e = this.current();
    if (!e || !e.ctx) return;
    try {
      this.logs = fs.readFileSync(e.ctx.logFile, 'utf8').trimEnd().split('\n');
    } catch {
      this.logs = ['(no log yet)'];
    }
  }

  handleLogs(key) {
    if (key === 'esc' || key === 'q') {
      this.mode = 'detail';
      return this.render();
    }
    if (key === 'esc: A' || key === 'k') this.logScroll = Math.min(this.logs.length, this.logScroll + 1);
    else if (key === 'esc: B' || key === 'j') this.logScroll = Math.max(0, this.logScroll - 1);
    else if (key === 'esc:~:5') this.logScroll = Math.min(this.logs.length, this.logScroll + 10);
    else if (key === 'esc:~:6') this.logScroll = Math.max(0, this.logScroll - 10);
    else if (key === 'r') this.loadLogs();
    this.render();
  }

  async handleActions(key) {
    if (key === 'esc' || key === 'q' || key === 'backspace') {
      this.mode = 'detail';
      return this.render();
    }
    const e = this.current();
    if (!e) return;
    const actions = this.actionsFor(e);
    if (key === 'esc: A' || key === 'k') {
      this.actionSel = (this.actionSel + actions.length - 1) % actions.length;
      return this.render();
    }
    if (key === 'esc: B' || key === 'j') {
      this.actionSel = (this.actionSel + 1) % actions.length;
      return this.render();
    }
    if (key !== 'enter') return;

    const action = actions[this.actionSel];
    if (!action.enabled) {
      this.message = { kind: 'err', text: `${action.label} is not available right now` };
      return this.render();
    }
    this.mode = 'detail';
    switch (action.id) {
      case 'start':
      case 'stop':
      case 'restart':
        return this.quick(action.id);
      case 'logs':
        return this.openLogs();
      case 'versions':
        this.mode = 'versions';
        this.versionSel = 0;
        this.remote = null;
        this.render();
        return this.loadRemote();
      case 'config': {
        this.message = { kind: 'ok', text: e.ctx.confFile || 'no marina-managed config' };
        return this.render();
      }
      case 'client': {
        this.message = { kind: 'ok', text: `marina exec ${e.key}@${e.major} -- ${e.engine.primaryClient}` };
        return this.render();
      }
      default:
        return this.render();
    }
  }

  async handleVersions(key) {
    if (key === 'esc' || key === 'q' || key === 'backspace') {
      this.mode = 'detail';
      return this.render();
    }
    const items = this.versionItems || [];
    if (key === 'esc: A' || key === 'k') {
      this.versionSel = (this.versionSel + Math.max(1, items.length) - 1) % Math.max(1, items.length);
      return this.render();
    }
    if (key === 'esc: B' || key === 'j') {
      this.versionSel = (this.versionSel + 1) % Math.max(1, items.length);
      return this.render();
    }
    if (key === 'g') {
      return this.loadRemote(true);
    }
    if (key !== 'enter') return;

    const item = items[this.versionSel];
    if (!item) return;
    const e = this.current();
    if (item.type === 'installed') {
      await this.run(`activating ${e.key} ${item.version}…`, async () => {
        await use(`${e.key}@${item.version}`, { quiet: true });
      });
      this.mode = 'detail';
      return;
    }
    await this.run(`installing ${e.key} ${item.version}…`, async () => {
      await install(`${e.key}@${item.version}`, {});
    });
    this.remote = null;
    this.mode = 'detail';
  }

  // ---------------------------------------------------------------- loop --
  async runLoop() {
    this.screen.onResize = () => this.render();
    const offKeys = readKeys((key) => {
      this.handle(key).catch((e) => {
        this.message = { kind: 'err', text: e.message.split('\n')[0] };
        this.render();
      });
    });
    this.refreshTimer = setInterval(() => {
      if (!this.busy && this.mode !== 'logs') this.refresh();
    }, 2500);
    this.render();
    await new Promise((resolve) => {
      const iv = setInterval(() => {
        if (this.done) {
          clearInterval(iv);
          resolve();
        }
      }, 50);
    });
    clearInterval(this.refreshTimer);
    this.stopSpin();
    offKeys();
  }
}

/** paths read better relative to the runtime root: engines/mysql/8.4/8.4.11 */
function relTo(p, w) {
  if (!p) return '—';
  const rel = path.relative(HOME, p);
  return truncMid(rel.startsWith('..') ? p : rel, w);
}

function truncLine(s, w) {
  return vlen(s) > w ? s.slice(0, Math.max(0, w - 1)) + '…' : s;
}

export async function runTui() {
  const screen = new Screen();
  screen.enter();
  const app = new App(screen);
  const restore = () => {
    screen.exit();
  };
  process.on('SIGINT', () => {
    app.done = true;
  });
  process.on('SIGTERM', () => {
    app.done = true;
  });
  try {
    await app.refresh();
    await app.runLoop();
  } finally {
    restore();
  }
}
