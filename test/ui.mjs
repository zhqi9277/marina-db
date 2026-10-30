// Terminal output helpers. NO_COLOR is forced before import so assertions are
// plain text, and writes are captured in-process (no terminal required).
import assert from 'node:assert/strict';
import test from 'node:test';

process.env.NO_COLOR = '1';
const ui = await import('../src/ui.js');

function captureOutput(fn) {
  const stdout = [];
  const stderr = [];
  const oldOut = process.stdout.write;
  const oldErr = process.stderr.write;
  process.stdout.write = (chunk) => { stdout.push(String(chunk)); return true; };
  process.stderr.write = (chunk) => { stderr.push(String(chunk)); return true; };
  try {
    fn();
  } finally {
    process.stdout.write = oldOut;
    process.stderr.write = oldErr;
  }
  return { out: stdout.join(''), err: stderr.join('') };
}

test('NO_COLOR produces plain color helpers and symbols', () => {
  assert.equal(ui.color.bold('x'), 'x');
  assert.equal(ui.color.red('y'), 'y');
  assert.deepEqual(ui.sym, { ok: '✓', fail: '✗', warn: '!', arrow: '›', dot: '·' });
});

test('table aligns columns and handles empty rows', () => {
  assert.equal(ui.table(['a', 'b'], []), 'a  b');

  const lines = ui.table(['name', 'value'], [['platform', 'macOS arm64'], ['node', '24.21.0']]).split('\n');
  assert.equal(lines.length, 3);
  assert.equal(lines[0].trimEnd(), 'name      value');
  assert.equal(lines[1], 'platform  macOS arm64');
  assert.equal(lines[2].trimEnd(), 'node      24.21.0');

  // right alignment pads the left side
  assert.equal(
    ui.table(['a', 'bb'], [['x', '1'], ['long', '22']], { align: ['left', 'right'] }),
    'a     bb\nx      1\nlong  22',
  );

  // widths are computed on visible characters, so ANSI codes do not break them
  const ansi = ui.table(['h'], [['\x1b[31mred\x1b[0m'], ['long']]).split('\n');
  assert.equal(ansi[0], 'h   ');
  assert.equal(ansi[1], '\x1b[31mred\x1b[0m ');
  assert.equal(ansi[2], 'long');

  // a short row is padded rather than printing "undefined"
  const short = ui.table(['a', 'b'], [['x']]);
  assert.doesNotMatch(short, /undefined/);
});

test('non-quiet helpers print the documented prefixes', () => {
  ui.setQuiet(false);
  assert.equal(ui.isQuiet(), false);

  assert.deepEqual(captureOutput(() => ui.info('working')), { out: '· working\n', err: '' });
  assert.deepEqual(captureOutput(() => ui.ok('done')), { out: '✓ done\n', err: '' });
  assert.deepEqual(captureOutput(() => ui.warn('careful')), { out: '', err: '! careful\n' });
  assert.deepEqual(captureOutput(() => ui.hint('try this')), { out: '  try this\n', err: '' });
  assert.deepEqual(captureOutput(() => ui.out('a', 'b', 1)), { out: 'a b 1\n', err: '' });
  assert.deepEqual(captureOutput(() => ui.err('a', 'b')), { out: '', err: 'a b\n' });
});

test('quiet mode silences info/ok/warn/hint but never failures', () => {
  ui.setQuiet(true);
  try {
    assert.equal(ui.isQuiet(), true);
    assert.deepEqual(captureOutput(() => {
      ui.info('i');
      ui.ok('o');
      ui.warn('w');
      ui.hint('h');
    }), { out: '', err: '' });

    assert.deepEqual(captureOutput(() => ui.fail('boom')), { out: '', err: '✗ boom\n' });
  } finally {
    ui.setQuiet(false);
  }
  assert.equal(ui.isQuiet(), false);
});

test('jsonOut writes pretty-printed JSON with a trailing newline', () => {
  assert.deepEqual(captureOutput(() => ui.jsonOut({ a: 1, b: [2] })), {
    out: '{\n  "a": 1,\n  "b": [\n    2\n  ]\n}\n',
    err: '',
  });
});

test('progress returns a no-op handle when stdout is not a tty', () => {
  const bar = ui.progress('download', 100);
  assert.equal(typeof bar.update, 'function');
  assert.equal(typeof bar.done, 'function');

  if (!process.stdout.isTTY) {
    assert.deepEqual(captureOutput(() => {
      bar.update(50);
      bar.update(100);
      bar.done();
    }), { out: '', err: '' });
  }
});

test('spinner returns the wrapped value and only animates on a tty', async () => {
  const value = await ui.spinner('scan', async () => 'result');
  assert.equal(value, 'result');
  assert.equal(await ui.spinner('sync', () => 7), 7);
});

test('isInteractive reflects stdin/stdout tty flags', () => {
  assert.equal(ui.isInteractive(), !!(process.stdin.isTTY && process.stdout.isTTY));
});
