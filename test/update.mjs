import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const official = 'https://github.com/zhqi9277/marina-db.git';
const files = ['package.json', 'bin/marina.js', 'src/update.js', 'src/ui/console.js'];

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marina update '));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const upstream = path.join(dir, 'upstream');
  const local = path.join(dir, 'installed marina');
  const env = { ...process.env, GIT_CONFIG_GLOBAL: path.join(dir, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' };
  delete env.MARINA_HOME;

  function git(cwd, ...args) {
    const result = spawnSync('git', ['-C', cwd, ...args], { env, encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 0, result.error?.message ?? result.stderr);
    return result.stdout.trim();
  }

  function commit(cwd, message) {
    git(cwd, '-c', 'user.name=Marina Tests', '-c', 'user.email=test@example.test', 'commit', '-m', message);
    return git(cwd, 'rev-parse', 'HEAD');
  }

  git(dir, 'init', '-b', 'main', upstream);
  for (const file of files) {
    const target = path.join(upstream, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(new URL('../' + file, import.meta.url), target);
  }
  fs.writeFileSync(path.join(upstream, '.gitignore'), '/runtime/\n');
  git(upstream, 'add', '.');
  const initial = commit(upstream, 'Install Marina');

  git(dir, 'clone', upstream, local);
  git(local, 'remote', 'set-url', 'origin', 'https://gitee.com/zhqi9277/marina.git');
  git(local, 'config', 'url.' + pathToFileURL(upstream).href + '.insteadOf', official);
  const launch = (entry, ...args) => spawnSync(process.execPath, [entry, 'update', ...args], {
    cwd: dir, env, encoding: 'utf8', timeout: 15000,
  });

  return {
    initial, upstream, local, git, commit, launch,
    run: (...args) => launch(path.join(local, 'bin', 'marina.js'), ...args),
    advance() {
      fs.writeFileSync(path.join(upstream, 'release.txt'), 'new CLI\n');
      git(upstream, 'add', 'release.txt');
      return commit(upstream, 'Publish an update');
    },
  };
}

function json(result) {
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  return JSON.parse(result.stdout);
}

function rejected(result, message) {
  assert.equal(result.status, 1, result.error?.message ?? result.stdout);
  assert.match(result.stderr, message);
}

test('update checks read-only and fast-forwards only the checkout supplying Marina', (t) => {
  const { initial, upstream, local, git, run, advance } = fixture(t);
  const latest = advance();
  git(upstream, 'tag', 'engines-qdrant');
  const config = fs.readFileSync(path.join(local, '.git', 'config'));
  const fetchHead = path.join(local, '.git', 'FETCH_HEAD');
  fs.writeFileSync(fetchHead, 'existing fetch metadata\n');

  assert.deepEqual(json(run('--check', '--json')), { status: 'different', current: initial, latest });
  assert.equal(git(local, 'rev-parse', 'HEAD'), initial);
  assert.equal(git(local, 'cat-file', '-t', initial), 'commit');
  assert.equal(git(local, 'for-each-ref', 'refs/marina'), '');
  assert.equal(fs.existsSync(path.join(local, 'runtime')), false);
  assert.equal(fs.existsSync(path.join(local, 'release.txt')), false);

  const runtime = path.join(local, 'runtime');
  fs.mkdirSync(runtime);
  fs.writeFileSync(path.join(runtime, 'state.json'), 'local database state');
  fs.writeFileSync(path.join(local, 'notes.txt'), 'local notes');
  assert.deepEqual(json(run('--json')), { status: 'updated', current: latest, latest });
  assert.equal(git(local, 'rev-parse', 'HEAD'), latest);
  assert.equal(git(local, 'rev-parse', 'origin/main'), initial);
  assert.equal(git(local, 'for-each-ref', 'refs/marina', 'refs/tags'), '');
  assert.equal(fs.readFileSync(fetchHead, 'utf8'), 'existing fetch metadata\n');
  assert.deepEqual(fs.readFileSync(path.join(local, '.git', 'config')), config);
  assert.equal(fs.readFileSync(path.join(runtime, 'state.json'), 'utf8'), 'local database state');
  assert.equal(fs.readFileSync(path.join(local, 'notes.txt'), 'utf8'), 'local notes');
  assert.equal(fs.readFileSync(path.join(local, 'release.txt'), 'utf8'), 'new CLI\n');
  assert.deepEqual(json(run('--check', '--json')), { status: 'up-to-date', current: latest, latest });
  assert.deepEqual(json(run('--json')), { status: 'up-to-date', current: latest, latest });
});

test('update protects tracked edits, other branches and in-progress Git operations', (t) => {
  const { initial, local, git, run, advance } = fixture(t);
  const latest = advance();
  const ignore = path.join(local, '.gitignore');
  const original = fs.readFileSync(ignore, 'utf8');
  fs.appendFileSync(ignore, '/example/\n');
  rejected(run(), /changes to tracked files/);
  assert.equal(fs.readFileSync(ignore, 'utf8'), original + '/example/\n');
  git(local, 'add', '.gitignore');
  rejected(run(), /changes to tracked files/);
  git(local, 'restore', '--staged', '--worktree', '.gitignore');

  git(local, 'switch', '-c', 'feature');
  rejected(run(), /local main branch/);
  assert.deepEqual(json(run('--check', '--json')), { status: 'different', current: initial, latest });
  git(local, 'switch', '--detach');
  rejected(run(), /local main branch/);
  git(local, 'switch', 'main');

  const mergeHead = path.join(local, '.git', 'MERGE_HEAD');
  fs.writeFileSync(mergeHead, initial + '\n');
  rejected(run(), /Finish the Git operation/);
  assert.equal(fs.readFileSync(mergeHead, 'utf8'), initial + '\n');
  assert.equal(git(local, 'rev-parse', 'HEAD'), initial);
});

test('update preserves local commits on ahead and diverged branches', (t) => {
  const { local, git, commit, run, advance } = fixture(t);
  fs.writeFileSync(path.join(local, 'local.txt'), 'my work');
  git(local, 'add', 'local.txt');
  const ours = commit(local, 'Local change');
  rejected(run(), /ahead of or has diverged/);
  advance();
  rejected(run(), /ahead of or has diverged/);
  assert.equal(git(local, 'rev-parse', 'HEAD'), ours);
  assert.equal(git(local, 'for-each-ref', 'refs/marina'), '');
});

test('update keeps untracked and ignored files when the upstream has a collision', (t) => {
  const { initial, local, upstream, git, run, commit, advance } = fixture(t);
  advance();
  const untracked = path.join(local, 'release.txt');
  fs.writeFileSync(untracked, 'local document');
  rejected(run(), /would be overwritten/);
  assert.equal(fs.readFileSync(untracked, 'utf8'), 'local document');
  fs.unlinkSync(untracked);

  fs.mkdirSync(path.join(upstream, 'runtime'));
  fs.writeFileSync(path.join(upstream, 'runtime', 'state.json'), 'upstream file');
  git(upstream, 'add', '-f', 'runtime/state.json');
  commit(upstream, 'Upstream adds a conflicting file');
  fs.mkdirSync(path.join(local, 'runtime'));
  const ignored = path.join(local, 'runtime', 'state.json');
  fs.writeFileSync(ignored, 'existing runtime data');
  rejected(run(), /would be overwritten/);
  assert.equal(fs.readFileSync(ignored, 'utf8'), 'existing runtime data');
  assert.equal(git(local, 'rev-parse', 'HEAD'), initial);
  assert.equal(git(local, 'for-each-ref', 'refs/marina'), '');
});

test('update handles a failed fetch and recommends the original channel for a packaged install', (t) => {
  const { initial, local, upstream, git, run, launch } = fixture(t);
  const packaged = path.join(local, 'node_modules', 'marina-db');
  for (const file of files) {
    const target = path.join(packaged, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(local, file), target);
  }
  rejected(launch(path.join(packaged, 'bin', 'marina.js'), '--check'), /original installation method/);
  assert.equal(fs.existsSync(path.join(packaged, 'runtime')), false);

  fs.renameSync(upstream, upstream + '-offline');
  rejected(run(), /does not appear to be a git repository|Could not read from remote repository/);
  assert.equal(git(local, 'rev-parse', 'HEAD'), initial);
  assert.equal(git(local, 'for-each-ref', 'refs/marina'), '');
});
