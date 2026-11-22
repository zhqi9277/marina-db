// Wrap a version-pinned upstream distribution or build it on the target OS.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { getEngine } from '../src/core/registry.js';
import { discoverRoot, findBin } from '../src/install/archive.js';
import { downloadFile, sha256File } from '../src/install/download.js';
import { artifactId, readBuildMatrix } from './engine-matrix.mjs';
import { sourcesFor } from './engine-sources.mjs';
import { relocate, verifyLibraries } from './portable-libraries.mjs';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(command + ' failed with status ' + result.status);
}

async function fetch(input, dir) {
  const file = path.join(dir, path.basename(new URL(input.url).pathname));
  await downloadFile(input.url, file, { sha256: input.sha256, size: input.size });
  return { file, url: input.url, sha256: await sha256File(file) };
}

const [key, version, outputDir = 'dist'] = process.argv.slice(2);
const target = readBuildMatrix(process.env.GITHUB_REF_NAME).find((row) =>
  row.engine === key && row.version === version && row.os === process.platform && row.arch === process.arch);
if (!target) throw new Error('usage: node scripts/package-engine.mjs <engine> <matrix version> [output dir] on a target runner');
const engine = getEngine(key);
const out = path.resolve(outputDir);
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'marina-package-'));

try {
  const { binary, source, additional, sourceCode } = sourcesFor(target);
  const inputs = await Promise.all([binary ?? source, ...additional].map((input) => fetch(input, work)));
  let root = path.join(work, 'payload');
  fs.mkdirSync(root);
  if (binary) {
    run('tar', ['-xf', inputs[0].file, '-C', root]);
    if (process.platform === 'win32' && ['redis', 'memcached'].includes(key)) {
      const server = findBin(root, engine.serverBin);
      if (!server) throw new Error('portable archive has no ' + engine.serverBin[0]);
      const bin = path.join(path.dirname(server), 'bin');
      if (path.basename(path.dirname(server)) !== 'bin') {
        fs.mkdirSync(bin);
        for (const name of fs.readdirSync(path.dirname(server))) {
          if (/\.(exe|dll)$/i.test(name)) fs.renameSync(path.join(path.dirname(server), name), path.join(bin, name));
        }
      }
    }
    const layout = discoverRoot(root, engine.markers);
    if (!layout) throw new Error('upstream archive has an unrecognized ' + key + ' layout');
    root = layout;
  } else {
    run('bash', ['scripts/build-engine.sh', key, inputs[0].file, root, ...inputs.slice(1).map(({ file }) => file)]);
  }

  if (key === 'mariadb') {
    // Keep the standalone server distribution, excluding clustering and test tools.
    for (const item of [
      'bin/garbd', 'lib/galera', 'lib/libgalera_smm.so', 'mariadb-test', 'mysql-test',
      'lib/plugin/ha_oqgraph.so', 'lib/plugin/cracklib_password_check.so',
    ]) {
      fs.rmSync(path.join(root, item), { recursive: true, force: true });
    }
  }

  const openssl = inputs.find(({ file }) => /^openssl-libs-.*\.rpm$/.test(path.basename(file)));
  if (key === 'mysql' && process.platform === 'linux' && openssl) {
    const compat = path.join(work, 'openssl-compat');
    fs.mkdirSync(compat);
    run('bsdtar', ['-xf', openssl.file, '-C', compat]);
    for (const library of ['libcrypto.so.1.1', 'libssl.so.1.1']) {
      const destination = path.join(root, 'lib', library);
      if (!fs.existsSync(destination)) fs.copyFileSync(path.join(compat, 'usr/lib64', library), destination);
    }
    fs.copyFileSync(path.join(compat, 'usr/share/licenses/openssl-libs/LICENSE'), path.join(root, 'LICENSE-OpenSSL-1.1'));
  }

  if (key === 'mongodb') {
    const shell = path.join(work, 'mongosh');
    fs.mkdirSync(shell);
    run('tar', ['-xf', inputs[1].file, '-C', shell]);
    const executable = findBin(shell, ['mongosh']);
    if (!executable) throw new Error('mongosh is missing from the upstream bundle');
    const bin = path.join(root, 'bin');
    for (const entry of fs.readdirSync(path.dirname(executable))) {
      fs.cpSync(path.join(path.dirname(executable), entry), path.join(bin, entry), { recursive: true });
    }
    const shellRoot = path.dirname(path.dirname(executable));
    for (const name of fs.readdirSync(shellRoot).filter((name) => /license|notice|copyright|third.party/i.test(name))) {
      fs.cpSync(path.join(shellRoot, name), path.join(root, 'mongosh-' + name), { recursive: true });
    }
  }

  for (const names of [engine.serverBin, ...(engine.primaryClient ? [[engine.primaryClient]] : [])]) {
    if (!findBin(root, names)) throw new Error('package is missing ' + names.join('/'));
  }
  const provenance = { inputs: inputs.map(({ url, sha256 }) => ({ url, sha256 })), sourceCode };
  fs.writeFileSync(path.join(root, 'MARINA-SOURCES.json'), JSON.stringify(provenance, null, 2) + '\n');
  await relocate(root);
  // Verify the staged archive in a different location so prefix paths cannot
  // resolve just because the original build output was left on the same runner.
  const moved = path.join(work, 'relocated payload');
  fs.renameSync(root, moved);
  verifyLibraries(moved);

  fs.mkdirSync(out, { recursive: true });
  const windows = process.platform === 'win32';
  const archive = path.join(out, artifactId(target) + (windows ? '.zip' : '.tar.gz'));
  run('tar', [windows ? '-acf' : '-czf', archive, '-C', moved, '.']);
  console.log(archive);
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
