// Full-screen interactive dashboard: two panes, live status,
// keyboard driven, no deps.
import fs from 'node:fs';
import { Screen, readKeys } from './screen.js';
import {
  SPIN_FRAMES, renderApp, paneLabel, headerLabel, renderSplit, renderDetail,
  renderActions, renderVersions, renderFull, renderPrompt, renderDoctor,
  renderHelp, renderLogs, renderKeys, renderMessage,
} from './views.js';
import {
  handleInput, handlePrompt, handleDoctor, handleLogs, handleActions, handleVersions,
} from './input.js';
import { collectEngines } from '../runtime/inventory.js';
import { start, stop, restart } from '../runtime/lifecycle.js';
import { listVersions } from '../install/versions.js';
import { runDoctor } from '../runtime/doctor.js';
import { isEnabled, enable, disable, enableAll, disableAll } from '../runtime/autostart.js';
import { setQuiet } from '../ui/console.js';

const VERSION = '0.1.0';

function needsStart(entry) {
  return entry.state !== 'running' && (!entry.runningVersion || entry.runningVersion === entry.version);
}

export class App {
  constructor(screen) {
    // Screen integration is the only terminal dependency held by App. Data,
    // navigation and transient UI state remain plain values for headless tests.
    this.screen = screen;

    // Navigation is intentionally centralized; views and handlers receive the
    // App instead of keeping their own copy of the selected database.
    this.mode = 'detail';
    this.sel = 0;
    this.actionSel = 0;
    this.versionSel = 0;

    // Authoritative inventory plus transient feedback shown in the status bar.
    this.engines = [];
    this.message = { kind: 'info', text: 'ready' };
    this.busy = null;
    this.spin = 0;

    // Screen-specific snapshots. A mode is discarded without mutating the
    // underlying inventory, so returning to detail always shows fresh state.
    this.logs = [];
    this.logScroll = 0;
    this.doctor = null;
    this.doctorScroll = 0;
    this.prompt = null;
    this.doctorAt = 0;
    this.remote = null;

    // These are internal lifecycle fields used to coalesce refreshes and stop
    // timers cleanly when the TUI exits.
    this.refreshing = null;
    this.done = false;
  }

  // ---------------------------------------------------------------- data --
  async refresh({ afterChange = false } = {}) {
    // Polling refreshes must not race an active operation. A caller that just
    // completed a mutation opts into afterChange so the result is re-read before
    // busy is cleared, even if a periodic refresh is already in flight.
    const blocked = () => this.done || (this.busy && !afterChange);
    if (blocked()) return;
    if (this.refreshing) {
      await this.refreshing;
      if (!afterChange || blocked() || this.refreshing) return this.refreshing;
    }
    this.refreshing = collectEngines().then((engines) => {
      if (blocked()) return;
      this.engines = engines;
      this.sel = Math.max(0, Math.min(this.sel, engines.length - 1));
    }, (e) => {
      if (!blocked()) this.message = { kind: 'err', text: e.message.split('\n')[0] };
    }).finally(() => {
      this.refreshing = null;
      if (!this.busy && !this.done) this.render();
    });
    return this.refreshing;
  }

  current() {
    return this.engines[this.sel] || null;
  }

  async run(label, fn) {
    // One operation owns the busy banner and quiet CLI output. The final refresh
    // happens before busy is cleared, so the next frame cannot show stale state.
    this.busy = label;
    this.message = { kind: 'info', text: label };
    setQuiet(true);
    this.startSpin();
    this.render();
    try {
      await fn();
      this.message = { kind: 'ok', text: `${label.replace(/\s*…$/, '')} done` };
      return true;
    } catch (e) {
      this.message = { kind: 'err', text: String(e.message || e).split('\n')[0] };
      return false;
    } finally {
      await this.refresh({ afterChange: true });
      setQuiet(false);
      this.busy = null;
      this.stopSpin();
      this.render();
    }
  }

  startSpin() {
    this.stopSpin();
    this.spinTimer = setInterval(() => {
      this.spin = (this.spin + 1) % SPIN_FRAMES.length;
      this.render();
    }, 90);
  }

  stopSpin() {
    if (this.spinTimer) clearInterval(this.spinTimer);
    this.spinTimer = null;
  }

  // Keep the original App rendering surface as thin delegates. Existing callers
  // can still invoke renderDetail()/renderActions(), while views.js owns layout.
  render() {
    return renderApp(this, VERSION);
  }

  paneLabel() {
    return paneLabel(this.mode);
  }

  headerLabel() {
    return headerLabel(this);
  }

  renderSplit(leftW, rightW, bodyH) {
    return renderSplit(this, leftW, rightW, bodyH);
  }

  renderDetail(w, h) {
    return renderDetail(this, w, h);
  }

  actionsFor(e) {
    const running = !!e.runningVersion || e.state === 'running' || e.state === 'degraded';
    const installed = e.state !== 'absent';
    return [
      { id: 'start', label: 'Start', enabled: installed && !running },
      { id: 'stop', label: 'Stop', enabled: installed && running },
      { id: 'restart', label: 'Restart', enabled: installed },
      { id: 'startAll', label: 'Start all', enabled: this.installedRows().some(needsStart) },
      { id: 'stopAll', label: 'Stop all', enabled: this.installedRows().some((x) => x.runningVersion || x.state === 'running' || x.state === 'degraded') },
      { id: 'doctor', label: 'Doctor', enabled: true },
      { id: 'port', label: 'Change port', enabled: installed },
      { id: 'user', label: 'Set user', enabled: installed },
      { id: 'password', label: 'Set password', enabled: installed },
      { id: 'logs', label: 'Show logs', enabled: installed },
      { id: 'versions', label: 'Versions / install', enabled: true },
      { id: 'config', label: 'Config path', enabled: installed },
      { id: 'client', label: 'Copy client command', enabled: installed },
      { id: 'back', label: 'Back', enabled: true },
    ];
  }

  renderActions(w, h) {
    return renderActions(this, w, h);
  }

  openVersions() {
    this.mode = 'versions';
    this.versionSel = 0;
    return this.loadRemote();
  }

  async loadRemote() {
    const engine = this.current();
    if (!engine) return;
    const pending = { loading: true, versions: [] };
    this.remote = pending;
    this.render();
    let result;
    try {
      const index = await listVersions(engine.key);
      result = { loading: false, ...index };
    } catch (err) {
      result = { loading: false, versions: [], error: err.message.split('\n')[0] };
    }
    if (this.done || this.mode !== 'versions' || this.remote !== pending) return;
    this.remote = result;
    this.render();
  }

  renderVersions(w, h) {
    return renderVersions(this, w, h);
  }

  renderFull(w, h) {
    return renderFull(this, w, h);
  }

  installedRows() {
    return this.engines.filter((e) => e.state !== 'absent' && e.ctx);
  }

  async bulk(action) {
    const installed = this.installedRows();
    const targets = action === 'start' ? installed.filter(needsStart) : installed;
    if (!targets.length) {
      this.message = { kind: 'info', text: installed.length ? 'all installed instances are running' : 'nothing installed' };
      return this.render();
    }
    const verb = action === 'start' ? 'starting' : 'stopping';
    this.busy = `${verb} all (${targets.length})…`;
    this.message = { kind: 'info', text: this.busy };
    setQuiet(true);
    this.startSpin();
    this.render();
    const failed = [];
    let done = 0;
    try {
      for (const e of targets) {
        try {
          if (action === 'start') await start(e.ctx, { quiet: true });
          else await stop(e.ctx, { quiet: true, instance: true });
          done++;
        } catch (err) {
          failed.push(`${e.label}: ${err.message.split('\n')[0]}`);
        }
        this.message = { kind: 'info', text: `${verb} ${done}/${targets.length}…` };
        this.render();
      }
    } finally {
      this.message = failed.length
        ? { kind: 'err', text: `${failed.length} failed — ${failed[0]}` }
        : { kind: 'ok', text: `${verb} all done (${done})` };
      await this.refresh({ afterChange: true });
      setQuiet(false);
      this.busy = null;
      this.stopSpin();
      this.render();
    }
  }

  async openDoctor() {
    this.mode = 'doctor';
    this.doctor = null;
    this.doctorScroll = 0;
    this.prompt = null;
    this.render();
    return this.loadDoctor();
  }

  async loadDoctor() {
    this.doctor = null;
    this.render();
    try {
      this.doctor = await runDoctor();
      this.doctorAt = Date.now();
    } catch (e) {
      this.doctor = [{ name: 'doctor', value: String(e.message || e).split('\n')[0], ok: false }];
    }
    this.render();
  }

  openPrompt(spec) {
    this.mode = 'prompt';
    this.prompt = spec;
    this.render();
  }

  renderPrompt(w, h) {
    return renderPrompt(this, w, h);
  }

  async handlePrompt(key) {
    return handlePrompt(this, key);
  }

  renderDoctor(w, h) {
    return renderDoctor(this, w, h);
  }

  async handleDoctor(key) {
    return handleDoctor(this, key);
  }

  renderHelp(w, h) {
    return renderHelp(this, w, h);
  }

  renderLogs(w, h) {
    return renderLogs(this, w, h);
  }

  renderKeys(w) {
    return renderKeys(this, w);
  }

  renderMessage() {
    return renderMessage(this);
  }

  // Key parsing, mode routing and mutation dispatch live in input.js. These
  // delegates preserve the App method surface used by the TUI and its tests.
  async handle(key) {
    return handleInput(this, key);
  }

  async quick(action) {
    const e = this.current();
    if (!e || e.state === 'absent') {
      this.message = { kind: 'err', text: `${e?.label || 'database'} is not installed` };
      return this.render();
    }
    const ctx = e.ctx;
    const label = { start: 'starting', stop: 'stopping', restart: 'restarting' }[action];
    const version = action === 'stop' ? e.runningVersion || e.version : e.version;
    await this.run(`${label} ${e.key} ${version}…`, async () => {
      if (action === 'start') await start(ctx, { quiet: true });
      else if (action === 'stop') await stop(ctx, { quiet: true, instance: true });
      else await restart(ctx, { quiet: true, instance: true });
    });
  }

  async toggleAutostart() {
    const e = this.current();
    if (!e || e.state === 'absent' || !e.ctx) {
      this.message = { kind: 'err', text: 'nothing installed for this database' };
      return this.render();
    }
    try {
      const on = isEnabled(e.ctx);
      const r = on ? disable([e.ctx]) : enable([e.ctx]);
      this.message = {
        kind: (r.warnings && r.warnings.length) ? 'err' : 'ok',
        text: (r.warnings && r.warnings[0]) || `autostart ${on ? 'off' : 'on'} for ${e.key}@${e.major}`,
      };
      await this.refresh();
    } catch (err) {
      this.message = { kind: 'err', text: String(err.message || err).split('\n')[0] };
      this.render();
    }
  }

  async toggleAutostartAll() {
    const rows = this.installedRows();
    if (!rows.length) {
      this.message = { kind: 'info', text: 'nothing installed' };
      return this.render();
    }
    try {
      const allOn = rows.every((x) => isEnabled(x.ctx));
      const r = allOn ? disableAll() : enableAll(rows.map((x) => x.ctx));
      this.message = {
        kind: (r.warnings && r.warnings.length) ? 'err' : 'ok',
        text: (r.warnings && r.warnings[0]) || `autostart all ${allOn ? 'off' : 'on'} (${r.ids.length})`,
      };
      await this.refresh();
    } catch (err) {
      this.message = { kind: 'err', text: String(err.message || err).split('\n')[0] };
      this.render();
    }
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
    return handleLogs(this, key);
  }

  async handleActions(key) {
    return handleActions(this, key);
  }

  async handleVersions(key) {
    return handleVersions(this, key);
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
