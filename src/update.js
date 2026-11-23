// Update the checkout that provides the CLI, even when invoked elsewhere.
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { jsonOut, out } from './ui/console.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const UPSTREAM = 'https://github.com/zhqi9277/marina-db.git';
const MAIN = 'refs/heads/main';
const COMMAND = 'marina update [--check] [--json]';
const exec = promisify(execFile);
const IN_PROGRESS = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer'];
const CHECKOUT_ENV = [
  'GIT_DIR', 'GIT_COMMON_DIR', 'GIT_WORK_TREE', 'GIT_IMPLICIT_WORK_TREE', 'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE',
  'GIT_GRAFT_FILE', 'GIT_SHALLOW_FILE', 'GIT_PREFIX', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT',
];

async function updateCheckout(check) {
  const unsupported = 'This Marina installation is outside a Git checkout. Upgrade it through its original installation method.';
  if (!existsSync(path.join(ROOT, '.git'))) throw new Error(unsupported);

  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };
  for (const name of CHECKOUT_ENV) delete env[name];

  async function git(...args) {
    try {
      const { stdout } = await exec('git', ['--no-replace-objects', '-C', ROOT, ...args], { env, timeout: 120000 });
      return stdout.replace(/\r?\n$/, '');
    } catch (error) {
      if (error.code === 'ENOENT') throw new Error('Git is required to update this Marina installation.');
      throw error;
    }
  }

  const checkout = await git('rev-parse', '--show-toplevel');
  if (path.relative(realpathSync(ROOT), realpathSync(checkout))) throw new Error(unsupported);
  const head = () => git('rev-parse', '--verify', 'HEAD');
  const current = await head();
  if (check) {
    const remote = await git('ls-remote', '--refs', '--exit-code', UPSTREAM, MAIN);
    const latest = /^([a-f0-9]{40})\trefs\/heads\/main$/.exec(remote)?.[1];
    if (!latest) throw new Error('Could not read the GitHub main commit.');
    return { status: current === latest ? 'up-to-date' : 'different', current, latest };
  }

  const gitDir = await git('rev-parse', '--absolute-git-dir');
  async function checkWorktree() {
    const branch = await git('symbolic-ref', '--quiet', 'HEAD').catch((error) => {
      if (error.code === 1) return null;
      throw error;
    });
    if (branch !== MAIN) throw new Error('Switch this Marina checkout to its local main branch before updating.');
    if (IN_PROGRESS.some((name) => existsSync(path.join(gitDir, name)))) {
      throw new Error('Finish the Git operation in this Marina checkout before updating.');
    }
    if (await git('status', '--porcelain=v1', '--untracked-files=no', '--ignore-submodules=none')) {
      throw new Error('This Marina checkout has changes to tracked files. Commit or stash them before updating.');
    }
  }

  await checkWorktree();
  const ref = 'refs/marina/update/' + randomUUID();
  try {
    await git('fetch', '--no-tags', '--no-prune', '--no-prune-tags', '--no-write-fetch-head',
      '--no-recurse-submodules', '--refmap=', UPSTREAM, `${MAIN}:${ref}`);
    const latest = await git('rev-parse', '--verify', ref + '^{commit}');
    await checkWorktree();

    const before = await head();
    if (before === latest) return { status: 'up-to-date', current: before, latest };
    if (before !== current) throw new Error('The Marina checkout changed during the download. Run marina update again.');
    try {
      await git('merge-base', '--is-ancestor', before, latest);
    } catch (error) {
      if (error.code === 1) throw new Error('Local main is ahead of or has diverged from GitHub main. Reconcile it before updating.');
      throw error;
    }
    await git('merge', '--ff-only', '--no-autostash', '--no-overwrite-ignore', latest);
    const updated = await head();
    if (updated !== latest) throw new Error('The Marina checkout changed during the update. Check it with marina update --check.');
    return { status: 'updated', current: updated, latest };
  } finally {
    await git('update-ref', '-d', ref);
  }
}

export async function runUpdate(args) {
  for (const flag of args) {
    if (!['--check', '--json', '--help', '-h'].includes(flag)) throw new Error(`Unknown update option "${flag}". Usage: ${COMMAND}`);
  }
  if (args.includes('--help') || args.includes('-h')) return out(COMMAND);

  const result = await updateCheckout(args.includes('--check')).catch((error) => {
    // Git's stderr gives a shorter explanation than the subprocess error, which
    // repeats the executable, arguments, and checkout path.
    if (error.stderr?.trim()) throw new Error(error.stderr.trim(), { cause: error });
    if (error.killed) throw new Error('The Git command timed out. Run marina update --check to check the current revision.', { cause: error });
    throw error;
  });
  if (args.includes('--json')) return jsonOut(result);
  const current = result.current.slice(0, 8);
  const latest = result.latest.slice(0, 8);
  if (result.status === 'updated') return out(`Marina updated to GitHub main (${latest}).`);
  if (result.status === 'up-to-date') return out(`Marina is up to date (${latest}).`);
  out(`Marina ${current} · GitHub main ${latest}`);
}
