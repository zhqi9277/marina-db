// Keyboard routing for the TUI.
//
// Handlers update App state and call App operations. They deliberately do not
// draw terminal text; the App renders after each state transition.
import { install, use } from '../install/installer.js';
import { changePort, changeAccount } from '../runtime/settings.js';
import { setQuiet } from '../ui/console.js';

function connection(e) {
  return e.engine.endpoint?.(e.ctx) ?? `marina exec ${e.key}@${e.major} -- ${e.engine.primaryClient}`;
}

export async function handleInput(app, key) {
  if (app.busy) {
    if (key === 'ctrl-c') app.done = true;
    return;
  }
  if (key === 'ctrl-c') {
    app.done = true;
    return;
  }

  if (app.mode === 'help') {
    if (key === 'esc' || key === '?' || key === 'q') app.mode = 'detail';
    app.render();
    return;
  }

  if (app.mode === 'prompt') return handlePrompt(app, key);
  if (app.mode === 'doctor') return handleDoctor(app, key);
  if (app.mode === 'logs') return handleLogs(app, key);
  if (app.mode === 'actions') return handleActions(app, key);
  if (app.mode === 'versions') return handleVersions(app, key);

  if (key === 'q') {
    app.done = true;
    return;
  }
  if (key === '?') {
    app.mode = 'help';
    app.render();
    return;
  }
  if (key === 'esc:A' || key === 'k') {
    app.sel = (app.sel + app.engines.length - 1) % Math.max(1, app.engines.length);
    app.render();
    return;
  }
  if (key === 'esc:B' || key === 'j') {
    app.sel = (app.sel + 1) % Math.max(1, app.engines.length);
    app.render();
    return;
  }
  const digit = Number(key);
  if (Number.isInteger(digit) && digit >= 1 && digit <= app.engines.length) {
    app.sel = digit - 1;
    app.render();
    return;
  }
  if (key === 'enter' || key === 'esc:C') {
    const e = app.current();
    const actions = e ? app.actionsFor(e) : [];
    const firstEnabled = actions.findIndex((a) => a.enabled);
    app.mode = 'actions';
    app.actionSel = Math.max(0, firstEnabled);
    app.render();
    return;
  }
  if (key === 'a') return app.toggleAutostart();
  if (key === 'A') return app.toggleAutostartAll();
  if (key === 'S') return app.bulk('start');
  if (key === 'X') return app.bulk('stop');
  if (key === 'd') return app.openDoctor();
  if (key === 's') return app.quick('start');
  if (key === 'x') return app.quick('stop');
  if (key === 'r') return app.quick('restart');
  if (key === 'l') return app.openLogs();
  if (key === 'v') return app.openVersions();
  if (key === 'c' || key === 'y') {
    const e = app.current();
    if (!e || e.state === 'absent') return;
    app.message = {
      kind: 'ok',
      text: key === 'c'
        ? (e.ctx.confFile || `${e.label} has no marina-managed config`)
        : connection(e),
    };
    app.render();
    return;
  }
  if (key === 'g') {
    app.message = { kind: 'info', text: 'refreshing…' };
    await app.refresh();
  }
}

export async function handlePrompt(app, key) {
  if (key === 'esc') {
    app.mode = 'detail';
    app.prompt = null;
    return app.render();
  }
  if (key === 'backspace') {
    app.prompt.value = String(app.prompt.value || '').slice(0, -1);
    return app.render();
  }
  if (key === 'ctrl-u') {
    app.prompt.value = '';
    return app.render();
  }
  if (key === 'enter') {
    const spec = app.prompt;
    const value = String(spec.value || '');
    app.busy = `${spec.label || 'value'}…`;
    app.message = { kind: 'info', text: app.busy };
    setQuiet(true);
    app.startSpin();
    app.render();
    try {
      const text = await spec.onSubmit(value);
      app.message = { kind: 'ok', text };
      await app.refresh({ afterChange: true });
      app.mode = 'detail';
      app.prompt = null;
    } catch (e) {
      app.message = { kind: 'err', text: String(e.message || e).split('\n')[0] };
    } finally {
      setQuiet(false);
      app.busy = null;
      app.stopSpin();
      app.render();
    }
    return;
  }
  if (key.length === 1 && key >= ' ' && key <= '~') {
    app.prompt.value = String(app.prompt.value || '') + key;
    return app.render();
  }
}

export async function handleDoctor(app, key) {
  if (key === 'esc' || key === 'q' || key === 'backspace') {
    app.mode = 'detail';
    return app.render();
  }
  const max = Math.max(0, (app.doctor?.length || 1) - 1);
  if (key === 'esc:A' || key === 'k') {
    app.doctorScroll = Math.min(max, Math.max(0, app.doctorScroll - 1));
  } else if (key === 'esc:B' || key === 'j') {
    app.doctorScroll = Math.min(max, app.doctorScroll + 1);
  } else if (key === 'g') {
    return app.loadDoctor();
  }
  return app.render();
}

export function handleLogs(app, key) {
  if (key === 'esc' || key === 'q') {
    app.mode = 'detail';
    return app.render();
  }
  if (key === 'esc:A' || key === 'k') app.logScroll = Math.min(app.logs.length, app.logScroll + 1);
  else if (key === 'esc:B' || key === 'j') app.logScroll = Math.max(0, app.logScroll - 1);
  else if (key === 'esc:~:5') app.logScroll = Math.min(app.logs.length, app.logScroll + 10);
  else if (key === 'esc:~:6') app.logScroll = Math.max(0, app.logScroll - 10);
  else if (key === 'r') app.loadLogs();
  app.render();
}

export async function handleActions(app, key) {
  if (key === 'esc' || key === 'q' || key === 'backspace') {
    app.mode = 'detail';
    return app.render();
  }
  const e = app.current();
  if (!e) return;
  const actions = app.actionsFor(e);
  if (key === 'esc:A' || key === 'k') {
    app.actionSel = (app.actionSel + actions.length - 1) % actions.length;
    return app.render();
  }
  if (key === 'esc:B' || key === 'j') {
    app.actionSel = (app.actionSel + 1) % actions.length;
    return app.render();
  }
  if (key !== 'enter') return;

  const action = actions[app.actionSel];
  if (!action.enabled) {
    app.message = { kind: 'err', text: `${action.label} is not available right now` };
    return app.render();
  }
  app.mode = 'detail';
  switch (action.id) {
    case 'start':
    case 'stop':
    case 'restart':
      return app.quick(action.id);
    case 'startAll':
      return app.bulk('start');
    case 'stopAll':
      return app.bulk('stop');
    case 'doctor':
      return app.openDoctor();
    case 'port':
      return app.openPrompt({
        title: `${e.label} port`,
        label: 'port',
        value: String(e.port),
        onSubmit: async (value) => {
          const r = await changePort(e.ctx, value);
          return `port ${r.port}${r.restarted ? ' · restarted' : ' · start to apply'}`;
        },
      });
    case 'user':
      return app.openPrompt({
        title: `${e.label} account`,
        label: 'user',
        value: e.ctx?.account?.user || '',
        onSubmit: async (value) => {
          const r = await changeAccount(e.ctx, { user: value });
          if (r.error) throw new Error(r.error);
          return `user saved${r.applied.length ? ' · applied' : ''}${r.notes.length ? ` · ${r.notes[0]}` : ''}`;
        },
      });
    case 'password':
      return app.openPrompt({
        title: `${e.label} password`,
        label: 'password',
        value: '',
        secret: true,
        onSubmit: async (value) => {
          const r = await changeAccount(e.ctx, { password: value });
          if (r.error) throw new Error(r.error);
          return `password saved${r.applied.length ? ' · applied' : ''}${r.notes.length ? ` · ${r.notes[0]}` : ''}`;
        },
      });
    case 'logs':
      return app.openLogs();
    case 'versions':
      return app.openVersions();
    case 'config':
      app.message = { kind: 'ok', text: e.ctx.confFile || 'no marina-managed config' };
      return app.render();
    case 'client':
      app.message = { kind: 'ok', text: connection(e) };
      return app.render();
    default:
      return app.render();
  }
}

export async function handleVersions(app, key) {
  if (key === 'esc' || key === 'q' || key === 'backspace') {
    app.remote = null;
    app.mode = 'detail';
    return app.render();
  }
  const items = app.versionItems || [];
  if (key === 'esc:A' || key === 'k') {
    app.versionSel = (app.versionSel + Math.max(1, items.length) - 1) % Math.max(1, items.length);
    return app.render();
  }
  if (key === 'esc:B' || key === 'j') {
    app.versionSel = (app.versionSel + 1) % Math.max(1, items.length);
    return app.render();
  }
  if (key === 'g') return app.loadRemote();
  if (key !== 'enter') return;

  const item = items[app.versionSel];
  if (!item) return;
  const e = app.current();
  if (item.type === 'installed') {
    const ok = await app.run(
      `activating ${e.key} ${item.version}…`,
      () => use(`${e.key}@${item.version}`, { quiet: true }),
    );
    if (ok) {
      app.remote = null;
      app.mode = 'detail';
    }
    return app.render();
  }
  const ok = await app.run(
    `installing ${e.key} ${item.version}…`,
    () => install(`${e.key}@${item.version}`, {}),
  );
  if (ok) {
    app.remote = null;
    app.mode = 'detail';
  }
  app.render();
}
