// ANSI helpers + box drawing for the TUI.
const E = '\x1b[';

export const C = {
  reset: `${E}0m`,
  bold: (s) => `${E}1m${s}${E}0m`,
  dim: (s) => `${E}2m${s}${E}0m`,
  fg: (n, s) => `${E}38;5;${n}m${s}${E}0m`,
  bg: (n, s) => `${E}48;5;${n}m${s}${E}0m`,
  inv: (s) => `${E}7m${s}${E}0m`,
  accent: (s) => `${E}38;5;173m${s}${E}0m`, // Claude orange (#d7875f)
  green: (s) => `${E}38;5;108m${s}${E}0m`, // muted sage
  yellow: (s) => `${E}38;5;179m${s}${E}0m`, // warm amber
  red: (s) => `${E}38;5;167m${s}${E}0m`, // soft terracotta
  magenta: (s) => `${E}38;5;175m${s}${E}0m`,
  gray: (s) => `${E}38;5;245m${s}${E}0m`,
  grayDark: (s) => `${E}38;5;240m${s}${E}0m`,
  selBg: (s) => `${E}48;5;237m${s}${E}0m`,
  border: (s) => `${E}38;5;239m${s}${E}0m`,
};

export function vlen(s) {
  return String(s).replace(/\x1b\[[0-9;]*m/g, '').length;
}

export function clip(s, w) {
  s = String(s);
  if (vlen(s) <= w) return s;
  let out = '';
  let n = 0;
  let i = 0;
  while (i < s.length && n < w) {
    if (s[i] === '\x1b') {
      const m = s.slice(i).match(/^\x1b\[[0-9;]*m/);
      if (m) {
        out += m[0];
        i += m[0].length;
        continue;
      }
    }
    out += s[i];
    n += 1;
    i += 1;
  }
  return out + C.reset;
}

export function fit(s, w, align = 'left') {
  const c = clip(s, w);
  const gap = Math.max(0, w - vlen(c));
  if (!gap) return c;
  return align === 'right' ? ' '.repeat(gap) + c : c + ' '.repeat(gap);
}

export function truncMid(s, w) {
  if (vlen(s) <= w) return s;
  if (w <= 3) return '.'.repeat(Math.max(0, w));
  const keep = w - 1;
  const left = Math.ceil(keep / 2);
  const right = Math.floor(keep / 2);
  return `${s.slice(0, left)}…${s.slice(s.length - right)}`;
}

/** ~/x/y/z/long/path -> …/long/path, keeping the tail visible */
export function shortPath(p, w, home) {
  let s = String(p || '');
  if (home && s.startsWith(home)) s = `~${s.slice(home.length)}`;
  return truncMid(s, w);
}

/** horizontal rule across the inner width, optionally meeting a vertical divider at `at` */
export function rule(w, { left = '├', mid = null, right = '┤', fill = '─', at = null } = {}) {
  if (mid && at != null) {
    return C.border(left + fill.repeat(at) + mid + fill.repeat(Math.max(0, w - at - 1)) + right);
  }
  return C.border(left + fill.repeat(w) + right);
}

export function top(w, left = '╭', right = '╮', title = '') {
  const inner = w - 2;
  if (!title) return C.border(left + '─'.repeat(inner) + right);
  const t = ` ${title} `;
  const rest = Math.max(0, inner - vlen(t));
  return C.border(left + '─') + t + C.border('─'.repeat(rest) + right);
}

export function bottom(w) {
  return C.border(`╰${'─'.repeat(w - 2)}╯`);
}

export function row(leftW, rightW, left, right) {
  return `${C.border('│')}${fit(left, leftW)}${C.border('│')}${fit(right, rightW)}${C.border('│')}`;
}

export function fullRow(w, text, align = 'left') {
  return `${C.border('│')}${fit(text, w - 2, align)}${C.border('│')}`;
}

export function badge(state) {
  switch (state) {
    case 'running': return C.green('● running');
    case 'degraded': return C.yellow('◐ degraded');
    case 'inactive': return C.gray('◌ inactive');
    case 'port-busy': return C.magenta('◑ port busy');
    case 'absent': return C.gray('· not installed');
    default: return C.gray('○ stopped');
  }
}

export function dot(state) {
  switch (state) {
    case 'running': return C.green('●');
    case 'degraded': return C.yellow('◐');
    case 'inactive': return C.gray('◌');
    case 'port-busy': return C.magenta('◑');
    case 'absent': return C.grayDark('·');
    default: return C.gray('○');
  }
}

export function keycap(k) {
  return `${C.fg(252, C.bg(238, ` ${k} `))}`;
}

export function keysBar(items, w) {
  const parts = items.map(([k, label]) => `${keycap(k)} ${C.gray(label)}`);
  let line = '';
  for (const p of parts) {
    const next = line ? `${line}  ${p}` : p;
    if (vlen(next) > w) break;
    line = next;
  }
  return line;
}

export function kv(label, value, labelW) {
  return `${C.gray(fit(label, labelW))}${value}`;
}
