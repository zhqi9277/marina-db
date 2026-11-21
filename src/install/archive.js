// Tar extraction and payload discovery.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { mkdirp } from '../core/paths.js';
import { info } from '../ui/console.js';
import { host } from '../host/index.js';
import { exe, IS_WIN, tarArgs } from '../core/platform.js';
import { clientEnv } from '../core/env.js';
export { expandArchiveArgs } from '../host/win32.js';

export function spawnAsync(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: [opts.input ? 'pipe' : 'ignore', 'pipe', 'pipe'], env: clientEnv(), ...opts });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => (stdout += d));
    child.stderr?.on('data', (d) => (stderr += d));
    if (opts.input) {
      child.stdin.on('error', (error) => {
        if (error.code !== 'EPIPE') reject(error);
      });
      child.stdin.end(opts.input);
    }
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

export async function extractTar(tarball, destDir) {
  mkdirp(destDir);
  info(`extracting ${path.basename(tarball)}`);
  const [flag] = tarArgs(tarball);
  const fallback = host.zipExtractArgs(tarball, destDir);
  let res = await spawnAsync('tar', [flag, tarball, '-C', destDir]).catch((err) => {
    if (fallback && err.code === 'ENOENT') return { code: 1 };
    throw err;
  });
  // Windows without bsdtar: the host falls back to PowerShell for zip payloads
  if (res.code !== 0) {
    if (fallback) res = await spawnAsync(fallback.cmd, fallback.args);
  }
  if (res.code !== 0) throw new Error(`tar failed (${res.code}): ${res.stderr.trim()}`);
  stripJunk(destDir);
  return destDir;
}

/**
 * Find the directory that looks like an install root by probing marker paths
 * such as "bin/mysqld". Handles both layouts seen in the wild:
 *   8.4.11/bin/mysqld   (versioned root)  and  bin/redis-server  (flat root)
 */
export function discoverRoot(dir, markers) {
  const names = IS_WIN ? markers.flatMap((marker) => [marker, executableName(marker)]) : markers;
  const queue = [{ dir, depth: 0 }];
  while (queue.length) {
    const { dir: cur, depth } = queue.shift();
    for (const marker of names) {
      if (fs.existsSync(path.join(cur, marker))) return cur;
    }
    if (depth >= 3) continue;
    let entries = [];
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.'));
    } catch {
      continue;
    }
    for (const e of entries) queue.push({ dir: path.join(cur, e.name), depth: depth + 1 });
  }
  return null;
}

const BIN_DIRS = ['bin', 'sbin', 'scripts', 'libexec', 'lib'];

function executableName(name) {
  return /\.(?:exe|cmd|bat)$/i.test(name) ? name : exe(name);
}

/** macOS sprinkles .DS_Store / ._* into extracted trees; they break "single top dir" logic */
function stripJunk(dir, depth = 0) {
  if (depth > 3) return;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.name === '.DS_Store' || e.name.startsWith('._')) {
      try { fs.rmSync(p, { force: true }); } catch {}
    } else if (e.isDirectory()) {
      stripJunk(p, depth + 1);
    }
  }
}

export function findBin(root, names) {
  if (!root) return null;
  const candidates = IS_WIN ? names.flatMap((name) => [executableName(name), name]) : names;
  // 1) the usual suspects, in order — covers bin/, sbin/ and scripts/ payloads
  for (const dir of BIN_DIRS) {
    for (const name of candidates) {
      const p = path.join(root, dir, name);
      try {
        const st = fs.statSync(p);
        if (st.isFile() && (IS_WIN || st.mode & 0o111)) return p;
      } catch {}
    }
  }
  // 2) proper BFS to depth 4 for unusual layouts
  const queue = [{ dir: root, depth: 0 }];
  while (queue.length) {
    const { dir, depth } = queue.shift();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory() && depth < 4 && !e.name.startsWith('.')) {
        queue.push({ dir: p, depth: depth + 1 });
      } else if (candidates.includes(e.name)) {
        try {
          const st = fs.statSync(p);
          if (st.isFile() && (IS_WIN || st.mode & 0o111)) return p;
        } catch {}
      }
    }
  }
  return null;
}

export function listDirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}
