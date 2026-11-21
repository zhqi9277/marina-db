// TUI rendering helpers.
//
// Views read App state and update only local cursor fields needed for clipping.
// They do not perform I/O or mutate service state, which keeps terminal layout
// deterministic enough to test without a real PTY.
import path from 'node:path';
import {
  C, vlen, fit, bottom, rule, row, fullRow, badge, dot, keysBar, shortPath, truncMid, kv,
} from './draw.js';
import { isEnabled } from '../runtime/autostart.js';
import { HOME, PROJECT_ROOT } from '../core/paths.js';
import { OS_LABEL } from '../core/platform.js';

export const SPIN_FRAMES = ['✻', '✶', '✳', '✢', '·'];

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

export function paneLabel(mode) {
  switch (mode) {
    case 'actions': return 'ACTIONS';
    case 'versions': return 'VERSIONS';
    default: return 'DETAIL';
  }
}

export function renderApp(app, version) {
  const W = app.screen.cols;
  const H = app.screen.rows;
  if (W < 64 || H < 16) {
    const msg = 'terminal too small — resize to at least 64x16';
    app.screen.draw(
      Array.from({ length: H }, (_, i) =>
        i === Math.floor(H / 2) ? C.yellow(fit(msg, W, 'left')) : ' '.repeat(W),
      ),
    );
    return;
  }

  // The outer border consumes two columns. The separator consumes one more;
  // everything in split mode is calculated from that stable inner width.
  const innerW = W - 2;
  const leftW = Math.max(26, Math.min(38, Math.floor(innerW * 0.4)));
  const rightW = innerW - leftW - 1;
  const bodyH = H - 7;
  const full = ['logs', 'help', 'doctor', 'prompt'].includes(app.mode);

  const lines = [];
  const homeLabel = HOME === path.join(PROJECT_ROOT, 'runtime')
    ? 'runtime/'
    : shortPath(HOME, Math.min(34, W - 34), HOME);
  const meta = `${app.engines.filter((e) => e.state !== 'absent').length} installed · ${homeLabel}`;
  lines.push(titleBar(W, `${C.yellow('🍊')} ${C.bold('marina')} ${C.gray(version)}`, C.gray(meta)));

  if (full) {
    const title = app.mode === 'logs'
      ? `LOGS ${headerLabel(app)}`
      : app.mode === 'doctor'
        ? 'DOCTOR'
        : app.mode === 'prompt'
          ? (app.prompt?.title || 'SETTINGS').toUpperCase()
          : 'KEYS';
    lines.push(fullRow(W, ` ${C.gray(title)}`));
    lines.push(rule(innerW, { left: '├', fill: '─', right: '┤' }));
  } else {
    lines.push(row(leftW, rightW, ` ${C.gray('DATABASES')}`, ` ${C.gray(paneLabel(app.mode))}`));
    lines.push(rule(innerW, { left: '├', mid: '┴', right: '┤', at: leftW }));
  }

  const body = full
    ? renderFull(app, innerW, bodyH)
    : renderSplit(app, leftW, rightW, bodyH);
  for (const line of body) {
    lines.push(full ? `${C.border('│')}${line}${C.border('│')}` : line);
  }

  lines.push(full
    ? rule(innerW, { left: '├', fill: '─', right: '┤' })
    : rule(innerW, { left: '├', mid: '┴', right: '┤', at: leftW }));
  lines.push(fullRow(W, ` ${renderKeys(app, innerW - 2)}`));
  lines.push(fullRow(W, ` ${renderMessage(app)}`));
  lines.push(bottom(W));

  app.screen.draw(lines.slice(0, H));
}

export function headerLabel(app) {
  const e = app.current();
  return e?.version ? `${e.label} ${e.version}` : '';
}

export function renderSplit(app, leftW, rightW, bodyH) {
  const left = [];
  for (let i = 0; i < bodyH; i++) {
    const e = app.engines[i];
    if (!e) {
      left.push(' ');
      continue;
    }
    const selected = i === app.sel;
    const downloaded = e.state !== 'absent';
    const port = downloaded ? String(e.port) : '';
    const marker = selected ? '▸ ' : '  ';
    const label = fit(e.label, 11);
    const ver = downloaded ? fit(e.version || '—', 9) : fit('not inst.', 9);
    const mark = !downloaded
      ? '↓'
      : e.state === 'running'
        ? '●'
        : e.state === 'degraded'
          ? '◐'
          : e.state === 'inactive'
            ? '◌'
            : e.state === 'unknown' ? '?' : '○';
    const plain = `${marker}${label}${ver} ${mark} ${port.padStart(5)}`;
    if (selected) {
      left.push(C.selBg(C.fg(255, fit(plain, leftW))));
    } else if (!downloaded) {
      left.push(fit(`  ${C.gray(label)}${C.grayDark(ver)} ${C.yellow(mark)} ${C.gray(port.padStart(5))}`, leftW));
    } else {
      left.push(fit(`  ${C.accent(label)}${C.fg(250, ver)} ${dot(e.state)} ${C.gray(port.padStart(5))}`, leftW));
    }
  }

  const right = app.mode === 'actions'
    ? renderActions(app, rightW, bodyH)
    : app.mode === 'versions'
      ? renderVersions(app, rightW, bodyH)
      : renderDetail(app, rightW, bodyH);

  const out = [];
  for (let i = 0; i < bodyH; i++) out.push(row(leftW, rightW, left[i] || ' ', right[i] || ' '));
  return out;
}

export function renderDetail(app, w, h) {
  const e = app.current();
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
  const acct = e.engine?.account?.(ctx);
  const otherVersion = e.runningVersion && e.runningVersion !== e.version;
  const state = otherVersion ? `${badge(e.instanceState)} ${C.gray(e.runningVersion)}` : badge(e.state);
  const pid = e.instancePid || e.pid;
  const rows = [
    ['state', state],
    ['port', C.fg(250, `127.0.0.1:${e.port}`)],
    ['pid', C.fg(250, pid ? String(pid) : '—')],
    ['active', e.row?.active ? C.accent('yes') : C.gray('no')],
    ['autostart', isEnabled(ctx) ? C.accent('on') : C.gray('off')],
    ['account', acct?.user ? C.fg(250, acct.user) : C.gray('—')],
    ['password', acct?.password
      ? C.fg(250, String(acct.password))
      : C.gray(acct?.mode === 'trust' ? '— (trust)' : '— (no auth)')],
    ['versions', C.fg(250, e.installed.join(', '))],
    ['payload', C.gray(relTo(ctx.versionDir, pad - 10))],
    ['data', C.gray(relTo(ctx.dataDir, pad - 10))],
    ['config', C.gray(ctx.confFile ? relTo(ctx.confFile, pad - 10) : '—')],
    ['log', C.gray(relTo(ctx.logFile, pad - 10))],
  ];
  for (const [k, v] of rows) lines.push(` ${kv(k, v, 10)}`);
  lines.push('');
  lines.push(` ${C.gray('client')} ${C.accent(`marina exec ${e.key}@${e.major}`)}`);
  return lines.slice(0, h).map((line) => fit(line, w));
}

export function renderActions(app, w, h) {
  const e = app.current();
  const lines = [];
  if (!e) return lines;
  lines.push(` ${panelTitle(`${e.label} ${e.version || ''}`, w - 2)}`);
  const actions = app.actionsFor(e);
  app.actionSel = Math.max(0, Math.min(app.actionSel, actions.length - 1));
  for (let i = 0; i < actions.length; i++) {
    const action = actions[i];
    const selected = i === app.actionSel;
    const text = ` ${selected ? '▸' : ' '} ${action.label}`;
    let cell;
    if (!action.enabled) cell = C.grayDark(text);
    else if (selected) cell = C.selBg(C.fg(255, fit(text, w - 2)));
    else cell = C.fg(250, text);
    lines.push(fit(cell, w));
  }
  lines.push('');
  lines.push(` ${C.gray('↑↓ choose · enter run · esc back')}`);
  return lines.slice(0, h);
}

export function renderVersions(app, w, h) {
  const e = app.current();
  if (!e) return [];
  const installed = e.installed || [];
  const activeVersion = e.row?.version;
  const items = [];
  for (const v of installed) {
    items.push({ type: 'installed', version: v, active: v === activeVersion });
  }
  if (app.remote && !app.remote.loading && !app.remote.error) {
    for (const v of app.remote.versions || []) {
      if (!installed.includes(v.version)) items.push({ type: 'remote', version: v.version, entry: v });
    }
  }
  app.versionItems = items;
  app.versionSel = Math.max(0, Math.min(app.versionSel || 0, Math.max(0, items.length - 1)));

  const lines = [];
  lines.push(` ${panelTitle(`${e.label} versions`, w - 2)}`);
  if (!app.remote || app.remote.loading) {
    lines.push(` ${C.gray('loading remote index…')}`);
  } else if (app.remote.error) {
    lines.push(` ${C.yellow('index unavailable')}`);
    lines.push(` ${C.gray(truncLine(app.remote.error, w - 4))}`);
  } else {
    lines.push(` ${C.gray(`${app.remote.versions.length} versions · index: ${app.remote.source}`)}`);
  }

  const viewH = Math.max(1, h - lines.length - 2);
  const start = Math.max(0, Math.min(app.versionSel - Math.floor(viewH / 2), items.length - viewH));
  let i = start;
  for (const item of items.slice(start, start + viewH)) {
    const selected = i === app.versionSel;
    const lead = ` ${selected ? '▸' : ' '} `;
    let cell;
    if (item.type === 'installed') {
      if (selected) {
        cell = C.selBg(C.fg(255, `${lead}◉ ${fit(item.version, 11)}${item.active ? ' active' : ''}`));
      } else {
        cell = lead + C.green('◉') + ' ' + C.fg(250, fit(item.version, 11)) + (item.active ? C.gray(' active') : '');
      }
    } else {
      const v = item.entry;
      const note = v.supported ? `${v.kind} · ${v.source}` : `n/a on ${OS_LABEL}`;
      if (selected) {
        cell = C.selBg(C.fg(255, `${lead}↓ ${fit(item.version, 11)} ${note}`));
      } else {
        cell = lead + C.yellow('↓') + ' ' + C.fg(250, fit(item.version, 11)) + ' ' + C.gray(note);
      }
    }
    lines.push(fit(cell, w));
    i++;
  }
  while (lines.length < h - 1) lines.push(fit(' ', w));
  lines.push(` ${C.gray('↑↓ choose · enter activate/install · g refresh · esc back')}`);
  return lines.slice(0, h);
}

export function renderFull(app, w, h) {
  if (app.mode === 'help') return renderHelp(app, w, h);
  if (app.mode === 'prompt') return renderPrompt(app, w, h);
  if (app.mode === 'doctor') return renderDoctor(app, w, h);
  return renderLogs(app, w, h);
}

export function renderPrompt(app, w, h) {
  const p = app.prompt || {};
  const lines = [];
  lines.push(fit(` ${C.gray(p.label || 'value')}`, w));
  lines.push(fit(' ', w));
  const shown = p.secret
    ? '•'.repeat(Math.min(64, String(p.value || '').length))
    : String(p.value || '');
  const value = shown
    ? C.fg(250, shown)
    : C.gray(p.secret ? '(empty = no password)' : '(empty)');
  lines.push(fit(` ${C.accent('>')} ${value}${C.accent('▏')}`, w));
  lines.push(fit(' ', w));
  lines.push(fit(` ${C.gray(p.secret ? 'enter apply (empty clears) · esc cancel' : 'enter apply · esc cancel')}`, w));
  while (lines.length < h) lines.push(fit(' ', w));
  return lines.slice(0, h);
}

export function renderDoctor(app, w, h) {
  const lines = [];
  if (!app.doctor) {
    lines.push(` ${C.gray('running self-check…')}`);
    while (lines.length < h) lines.push(' '.repeat(w));
    return lines.slice(0, h).map((line) => fit(line, w));
  }
  const bad = app.doctor.filter((c) => !c.ok).length;
  const when = app.doctorAt ? new Date(app.doctorAt).toLocaleTimeString() : '';
  lines.push(fit(` ${C.gray(`${app.doctor.length} checks · ${bad} failed${when ? ` · ${when}` : ''}`)}`, w));
  const viewH = Math.max(1, h - 2);
  const start = Math.max(0, Math.min(app.doctorScroll, Math.max(0, app.doctor.length - viewH)));
  for (const c of app.doctor.slice(start, start + viewH)) {
    const mark = c.ok ? C.green('ok  ') : C.red('fail');
    lines.push(fit(` ${mark} ${C.fg(250, fit(c.name, 11))} ${C.gray(c.value)}`, w));
  }
  while (lines.length < h - 1) lines.push(fit(' ', w));
  lines.push(fit(` ${C.gray('↑↓ scroll · g rerun · esc back')}`, w));
  return lines.slice(0, h);
}

export function renderHelp(app, w, h) {
  const rows = [
    ['↑ ↓ / j k', 'move selection'],
    ['enter', 'actions for the selected database'],
    ['s / x / r', 'start / stop / restart'],
    ['S / X', 'start all / stop all'],
    ['d', 'doctor: environment self-check'],
    ['actions', 'port / user / password, then enter'],
    ['a / A', 'autostart: this / all'],
    ['v', 'versions: activate installed, install new major'],
    ['l', 'logs (↑↓ scroll, pgup/pgdn, esc back)'],
    ['c', 'print config path'],
    ['y', 'print client command'],
    ['g', 'refresh now'],
    ['1…6', 'jump to database'],
    ['gitee', 'gitee.com/zhqi9277/marina'],
    ['q', 'quit'],
  ];
  const lines = [];
  lines.push(` ${panelTitle('keyboard', w - 2)}`);
  for (const [key, value] of rows) {
    lines.push(`  ${C.fg(252, C.bg(238, ` ${fit(key, 12)} `))}  ${C.fg(250, value)}`);
  }
  lines.push('');
  lines.push(` ${C.gray('marina is local only: no root, no launchd, everything lives under')} ${C.accent(shortPath(HOME, 40, HOME))}`);
  while (lines.length < h) lines.push(' '.repeat(w));
  return lines.slice(0, h).map((line) => fit(line, w));
}

export function renderLogs(app, w, h) {
  const e = app.current();
  const lines = [];
  if (!e || e.state === 'absent') {
    lines.push(` ${C.gray('nothing installed for this database')}`);
    return lines.slice(0, h).map((line) => fit(line, w));
  }
  const viewH = h - 2;
  const start = Math.max(0, app.logs.length - viewH - app.logScroll);
  const slice = app.logs.slice(start, start + viewH);
  for (const line of slice) lines.push(fit(` ${line}`, w));
  while (lines.length < viewH) lines.push(fit(' ', w));
  lines.push(fit(` ${C.gray(shortPath(e.ctx.logFile, w - 4, HOME))}`, w));
  lines.push(fit(` ${C.gray(`${app.logs.length} lines · ↑↓ scroll · r reload · esc back`)}`, w));
  return lines;
}

export function renderKeys(app, w) {
  if (app.mode === 'actions') return keysBar([['↑↓', 'choose'], ['enter', 'run'], ['esc', 'back'], ['q', 'quit']], w);
  if (app.mode === 'versions') return keysBar([['↑↓', 'choose'], ['enter', 'select'], ['esc', 'back'], ['q', 'quit']], w);
  if (app.mode === 'logs') return keysBar([['↑↓', 'scroll'], ['r', 'reload'], ['esc', 'back'], ['q', 'quit']], w);
  if (app.mode === 'doctor') return keysBar([['↑↓', 'scroll'], ['g', 'rerun'], ['esc', 'back'], ['q', 'quit']], w);
  if (app.mode === 'prompt') return keysBar([['enter', 'apply'], ['esc', 'cancel']], w);
  if (app.mode === 'help') return keysBar([['esc', 'back'], ['q', 'quit']], w);
  return keysBar(
    [['↑↓', 'move'], ['enter', 'actions'], ['s/x/r', 'start/stop/restart'], ['S/X', 'all'], ['a/A', 'autostart'], ['v', 'versions'], ['l', 'logs'], ['d', 'doctor'], ['?', 'keys'], ['q', 'quit']],
    w,
  );
}

export function renderMessage(app) {
  if (app.busy) return `${C.accent(SPIN_FRAMES[app.spin % SPIN_FRAMES.length])} ${C.fg(250, app.busy)}`;
  const m = app.message || {};
  const text = m.text || '';
  if (m.kind === 'ok') return `${C.green('✓')} ${C.fg(250, text)}`;
  if (m.kind === 'err') return `${C.red('✗')} ${C.red(text)}`;
  return `${C.gray('·')} ${C.gray(text)}`;
}

/** Show paths relative to the runtime root so moved installs stay readable. */
function relTo(file, width) {
  if (!file) return '—';
  const rel = path.relative(HOME, file);
  return truncMid(rel.startsWith('..') ? file : rel, width);
}

function truncLine(s, width) {
  return vlen(s) > width ? s.slice(0, Math.max(0, width - 1)) + '…' : s;
}
