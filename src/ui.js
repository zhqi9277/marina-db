// Terminal output helpers: colors, tables, progress, prompts.
import readline from 'node:readline';

const tty = process.stdout.isTTY;
const noColor = !!process.env.NO_COLOR || !tty;
const c = (n) => (s) => (noColor ? s : `\x1b[${n}m${s}\x1b[0m`);

export const color = {
  bold: c('1'), dim: c('2'), red: c('31'), green: c('32'),
  yellow: c('33'), blue: c('34'), magenta: c('35'), cyan: c('36'), gray: c('90'),
};

export const sym = {
  ok: color.green('✓'),
  fail: color.red('✗'),
  warn: color.yellow('!'),
  arrow: color.cyan('›'),
  dot: color.gray('·'),
};

let quietMode = false;
export function setQuiet(v) { quietMode = !!v; }
export function isQuiet() { return quietMode; }

export const out = (...a) => process.stdout.write(a.join(' ') + '\n');
export const err = (...a) => process.stderr.write(a.join(' ') + '\n');

export function info(msg) { if (!quietMode) out(`${sym.dot} ${msg}`); }
export function ok(msg) { if (!quietMode) out(`${sym.ok} ${msg}`); }
export function warn(msg) { if (!quietMode) err(`${sym.warn} ${color.yellow(msg)}`); }
export function fail(msg) { err(`${sym.fail} ${color.red(msg)}`); }
export function hint(msg) { if (!quietMode) out(color.gray(`  ${msg}`)); }

// ---- tables ----------------------------------------------------------------
export function table(headers, rows, { align = [] } = {}) {
  const all = [headers, ...rows];
  const widths = headers.map((_, i) => Math.max(...all.map((r) => visible(String(r[i] ?? '')).length)));
  const pad = (s, i) => {
    const raw = String(s ?? '');
    const len = visible(raw).length;
    const space = ' '.repeat(Math.max(0, widths[i] - len));
    return align[i] === 'right' ? space + raw : raw + space;
  };
  const line = headers.map((h, i) => color.bold(pad(h, i))).join('  ');
  const body = rows.map((r) => r.map((cell, i) => pad(cell, i)).join('  '));
  return [line, ...body].join('\n');
}

function visible(s) {
  // strip ANSI escape sequences for width math
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

// ---- progress --------------------------------------------------------------
export function progress(label, total) {
  if (!tty || quietMode) return { update() {}, done() {} };
  let last = -1;
  const width = 28;
  const started = Date.now();
  return {
    update(received) {
      const pct = total ? Math.floor((received / total) * 100) : 0;
      if (pct === last) return;
      last = pct;
      const filled = Math.round((pct / 100) * width);
      const bar = '█'.repeat(filled) + '░'.repeat(width - filled);
      const mb = (received / 1048576).toFixed(1);
      const totalMb = total ? (total / 1048576).toFixed(1) : '?';
      const secs = (Date.now() - started) / 1000;
      const speed = secs > 0.5 ? `${(received / 1048576 / secs).toFixed(1)} MB/s` : '';
      process.stdout.write(`\r  ${label} ${bar} ${String(pct).padStart(3)}% ${mb}/${totalMb} MB ${speed}   `);
    },
    done() {
      if (last >= 0) process.stdout.write('\r' + ' '.repeat(90) + '\r');
    },
  };
}

export async function spinner(label, fn) {
  if (!tty) return fn();
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let i = 0;
  const t = setInterval(() => {
    process.stdout.write(`\r  ${color.cyan(frames[(i++) % frames.length])} ${label}   `);
  }, 80);
  try {
    return await fn();
  } finally {
    clearInterval(t);
    process.stdout.write('\r' + ' '.repeat(70) + '\r');
  }
}

// ---- prompts ---------------------------------------------------------------
export function isInteractive() {
  return !!(process.stdin.isTTY && process.stdout.isTTY);
}

export async function ask(question, { default: def = '' } = {}) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const suffix = def ? color.gray(` (${def})`) : '';
  const answer = await new Promise((res) => rl.question(`${color.cyan('?')} ${question}${suffix} `, res));
  rl.close();
  return answer.trim() || def;
}

export async function select(question, items, { defaultIndex = 0 } = {}) {
  out(`${color.cyan('?')} ${question}`);
  items.forEach((it, i) => {
    const marker = i === defaultIndex ? color.cyan('❯') : ' ';
    const label = typeof it === 'string' ? it : it.label;
    const extra = typeof it === 'string' ? '' : color.gray(it.hint || '');
    out(`  ${marker} ${color.bold(String(i + 1))}. ${label} ${extra}`);
  });
  const answer = await ask('number', { default: String(defaultIndex + 1) });
  const idx = Math.max(1, Math.min(items.length, parseInt(answer, 10) || defaultIndex + 1)) - 1;
  return { index: idx, item: items[idx] };
}

export function jsonOut(value) {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}
