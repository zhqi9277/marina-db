// Hardening for code paths that only execute on Windows/Linux (this host is
// macOS). Everything is fixture-driven: no database process, no powershell,
// no systemctl and no network access.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'marina-hardening-'));
process.env.MARINA_HOME = HOME;

const registry = await import('../src/registry.js');
const { expandArchiveArgs } = await import('../src/archive.js');
const { renderUnit, systemdEscape, xmlEscape, CLI, NODE } = await import('../src/autostart.js');
const { linkDir, linkFile, IS_WIN } = await import('../src/platform.js');

const { engines } = registry;

after(() => fs.rmSync(HOME, { recursive: true, force: true }));

const enginePath = (...parts) => path.join(HOME, 'engines', ...parts);

/** pull the single -Command payload out of a powershell argv */
function commandOf(args) {
  const index = args.indexOf('-Command');
  assert.ok(index > 0, 'missing -Command');
  assert.equal(args[index - 1], '-NonInteractive');
  assert.equal(args.length, index + 2, 'expected exactly one -Command payload');
  return args[index + 1];
}

test('installedVersions ignores current and dot-prefixed directories', () => {
  // A Windows linkDir fallback leaves a real `current` directory; staging uses
  // dot-prefixed dirs. Neither may be listed as an installed version.
  fs.mkdirSync(enginePath('redis', '7', '7.2.5'), { recursive: true });
  fs.mkdirSync(enginePath('redis', '7', 'current'), { recursive: true });
  fs.writeFileSync(path.join(enginePath('redis', '7', 'current'), 'redis-server'), 'copy');
  fs.mkdirSync(enginePath('redis', '7', '.stage-x'), { recursive: true });
  fs.writeFileSync(path.join(enginePath('redis', '7', 'README.txt')), 'not a version');
  fs.mkdirSync(enginePath('redis', '.trash', '9.9.9'), { recursive: true });

  const rows = registry.installedVersions(engines.redis);
  assert.deepEqual(rows.map((r) => `${r.major}/${r.version}`), ['7/7.2.5']);
  assert.equal(rows[0].dir, enginePath('redis', '7', '7.2.5'));
  // pickVersion must never resolve the current copy
  assert.equal(registry.pickVersion(engines.redis, null).version, '7.2.5');
  assert.equal(registry.pickVersion(engines.redis, 'current'), null);
});

test('installedVersions ignores a POSIX current symlink', { skip: IS_WIN }, () => {
  fs.rmSync(enginePath('redis', '7', 'current'), { recursive: true, force: true });
  fs.symlinkSync(enginePath('redis', '7', '7.2.5'), enginePath('redis', '7', 'current'), 'dir');

  const versions = registry.installedVersions(engines.redis).map((r) => r.version);
  assert.deepEqual(versions, ['7.2.5']);
});

test('expandArchiveArgs builds a terminating Expand-Archive command', () => {
  const args = expandArchiveArgs(
    'C:\\Users\\Jane Doe\\Downloads\\redis.zip',
    'C:\\Users\\Jane Doe\\marina\\tmp',
  );
  assert.equal(args[0], '-NoProfile');
  const script = commandOf(args);
  for (const token of ['Expand-Archive', '-LiteralPath', '-DestinationPath', '-Force', '-ErrorAction Stop']) {
    assert.ok(script.includes(token), `missing ${token}`);
  }
  assert.ok(script.includes("'C:\\Users\\Jane Doe\\Downloads\\redis.zip'"));
  assert.ok(script.includes("'C:\\Users\\Jane Doe\\marina\\tmp'"));
  // the terminating action must govern the cmdlet invocation
  assert.ok(script.indexOf('-Force') < script.indexOf('-ErrorAction Stop'));
});

test('expandArchiveArgs quotes spaces, single quotes and $ literally', () => {
  const tarball = "/Users/zoë/O'Brien's $HOME/marina's db.zip";
  const dest = "/tmp/O'Brien's dest %TEMP%";
  const script = commandOf(expandArchiveArgs(tarball, dest));

  assert.ok(script.includes("'/Users/zoë/O''Brien''s $HOME/marina''s db.zip'"));
  assert.ok(script.includes("'/tmp/O''Brien''s dest %TEMP%'"));
  // an unescaped apostrophe would terminate the PowerShell string literal
  assert.equal(script.includes("O'Brien's"), false);
  assert.equal((script.match(/'/g) || []).length % 2, 0);
});

test('systemdEscape doubles % specifiers and $ variables', () => {
  assert.equal(systemdEscape('/opt/marina%/bin/redis-server'), '/opt/marina%%/bin/redis-server');
  assert.equal(systemdEscape('/home/$USER/marina'), '/home/$$USER/marina');
  assert.equal(systemdEscape('50%$/x%%$y'), '50%%$$/x%%%%$$y');
});

test('systemd ExecStart escapes NODE and CLI and keeps the start command', () => {
  const target = { manager: 'systemd', dir: '/tmp/x', file: '/tmp/x/marina-autostart.service' };
  const unit = renderUnit(['redis:7', 'mysql:8.4'], target);
  const exec = unit.split('\n').find((line) => line.startsWith('ExecStart='));
  assert.ok(exec, 'missing ExecStart');
  assert.equal(exec, `ExecStart="${systemdEscape(NODE)}" "${systemdEscape(CLI)}" start --autostart`);
  assert.match(unit, /Description=marina autostart databases \(redis:7, mysql:8\.4\)/);
  // no bare % or $ survives in ExecStart: only doubled forms remain
  for (let i = 0; i < exec.length; i += 1) {
    if (exec[i] === '%' || exec[i] === '$') {
      assert.equal(exec[i + 1], exec[i], `unescaped ${exec[i]} at offset ${i}`);
      i += 1;
    }
  }
});

test('launchd unit keeps ProgramArguments and XML escaping', () => {
  const xml = renderUnit(['mysql:8.4'], { manager: 'launchd', dir: '/tmp', file: '/tmp/x.plist' });
  assert.match(xml, /<key>ProgramArguments<\/key>\s*<array>/);
  assert.ok(xml.includes(`<string>${xmlEscape(NODE)}</string>`));
  assert.ok(xml.includes(`<string>${xmlEscape(CLI)}</string>`));
  assert.match(xml, /<string>start<\/string>\s*<string>--autostart<\/string>/);
  // plist values are literal: XML escaping is the only transform here
  assert.equal(xmlEscape('a&b<c>"d"'), 'a&amp;b&lt;c&gt;&quot;d&quot;');
});

test('linkDir replaces a non-empty real directory without nesting a copy', () => {
  const target = path.join(HOME, 'link-target');
  fs.mkdirSync(path.join(target, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(target, 'bin', 'redis-server'), 'new payload');
  const link = path.join(HOME, 'link-dir');
  fs.mkdirSync(path.join(link, 'old'), { recursive: true });
  fs.writeFileSync(path.join(link, 'stale.txt'), 'stale');

  const mode = linkDir(target, link);
  assert.ok(mode === 'symlink' || mode === 'copy');
  assert.equal(fs.readFileSync(path.join(link, 'bin', 'redis-server'), 'utf8'), 'new payload');
  assert.equal(fs.existsSync(path.join(link, 'stale.txt')), false);
  assert.equal(fs.existsSync(path.join(link, 'old')), false);
  // cpSync must not have produced link/link-target/... nested payloads
  assert.equal(fs.existsSync(path.join(link, path.basename(target))), false);
  if (!IS_WIN) {
    assert.equal(mode, 'symlink');
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
    assert.equal(fs.realpathSync(link), fs.realpathSync(target));
  }
});

test('linkFile replaces an existing file and tracks source updates', () => {
  const source = path.join(HOME, 'link-source.txt');
  const link = path.join(HOME, 'link-file.txt');
  fs.writeFileSync(source, 'first');
  fs.writeFileSync(link, 'stale');

  const mode = linkFile(source, link);
  assert.ok(mode === 'symlink' || mode === 'copy');
  assert.equal(fs.readFileSync(link, 'utf8'), 'first');
  if (!IS_WIN) assert.equal(mode, 'symlink');

  fs.writeFileSync(source, 'second');
  assert.equal(linkFile(source, link), mode);
  assert.equal(fs.readFileSync(link, 'utf8'), 'second');
});

test('autostart reports unsupported platforms through renderUnit(ids, null)', () => {
  assert.throws(() => renderUnit([], null), (error) => {
    assert.match(error.message, /autostart is only implemented for macOS and Linux/);
    return true;
  });
  assert.throws(() => renderUnit(['mysql:8.4'], null), /only implemented for macOS and Linux/);
});
