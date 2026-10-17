// Full-screen terminal: alternate buffer, raw input, resize, cleanup.
const ESC = '\x1b[';

export class Screen {
  constructor(stream = process.stdout) {
    this.out = stream;
    this.entered = false;
    this.onResize = null;
    this._resize = () => this.onResize?.();
  }

  get cols() {
    return this.out.columns || 80;
  }

  get rows() {
    return this.out.rows || 24;
  }

  enter() {
    if (this.entered) return;
    this.entered = true;
    this.out.write(`${ESC}?1049h${ESC}?25l${ESC}2J`);
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
      process.stdin.resume();
    }
    process.stdout.on('resize', this._resize);
  }

  exit() {
    if (!this.entered) return;
    this.entered = false;
    process.stdout.off('resize', this._resize);
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    // show cursor, leave alternate buffer
    this.out.write(`${ESC}?25h${ESC}?1049l`);
  }

  /** lines: array of strings already sized to this.cols (ANSI allowed). */
  draw(lines) {
    const body = lines.join(`\n${ESC}K`);
    this.out.write(`${ESC}H${body}${ESC}K${ESC}J`);
  }

  clear() {
    this.out.write(`${ESC}2J${ESC}H`);
  }
}

/** Read raw keys, including arrow sequences. */
export function readKeys(onKey) {
  const handler = (chunk) => {
    const s = chunk.toString('utf8');
    let i = 0;
    while (i < s.length) {
      if (s[i] === '\x1b' && s[i + 1] === '[') {
        const rest = s.slice(i);
        const m = rest.match(/^\x1b\[([0-9;]*)([A-Za-z~])/);
        if (m) {
          onKey(`esc:${m[2]}${m[1] ? `:${m[1]}` : ''}`);
          i += m[0].length;
          continue;
        }
        onKey('esc');
        i += 1;
        continue;
      }
      const ch = s[i];
      if (ch === '\r' || ch === '\n') onKey('enter');
      else if (ch === '\t') onKey('tab');
      else if (ch === '\x7f') onKey('backspace');
      else if (ch === '\x03') onKey('ctrl-c');
      else if (ch === '\x1b') onKey('esc');
      else onKey(ch);
      i += 1;
    }
  };
  process.stdin.on('data', handler);
  return () => process.stdin.off('data', handler);
}
