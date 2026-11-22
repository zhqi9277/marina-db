// Wrap a version-pinned upstream distribution or build it on the target OS.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { getEngine } from '../src/core/registry.js';
import { discoverRoot, findBin } from '../src/install/archive.js';
import { downloadFile, sha256File } from '../src/install/download.js';
import { readBuildMatrix } from './engine-matrix.mjs';
import { archiveName } from './make-manifest.mjs';
import { sourcesFor } from './engine-sources.mjs';
import { relocate, verifyLibraries } from './portable-libraries.mjs';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(command + ' failed with status ' + result.status);
}

async function fetchInput(input, dir) {
  const url = new URL(input.url);
  const bottle = url.origin === 'https://ghcr.io' &&
    /^\/v2\/(homebrew\/core\/[a-z0-9_./-]+)\/blobs\/sha256:([a-f0-9]{64})$/.exec(url.pathname);
  if (!bottle) {
    const file = path.join(dir, path.basename(url.pathname));
    await downloadFile(input.url, file, { sha256: input.sha256, size: input.size });
    return { file, url: input.url, sha256: await sha256File(file) };
  }

  const [, repository, digest] = bottle;
  if (digest !== input.sha256) throw new Error('Homebrew bottle digest differs from the locked input');
  const auth = new URL('https://ghcr.io/token');
  auth.searchParams.set('service', 'ghcr.io');
  auth.searchParams.set('scope', `repository:${repository}:pull`);
  const authResponse = await fetch(auth, { signal: AbortSignal.timeout(30000) });
  if (!authResponse.ok) throw new Error(`Homebrew registry authentication HTTP ${authResponse.status}`);
  const { token } = await authResponse.json();
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(300000),
  });
  if (!response.ok) throw new Error(`Homebrew bottle download HTTP ${response.status}: ${repository}`);
  const file = path.join(dir, `${digest}.tar.gz`);
  await pipeline(response.body, fs.createWriteStream(file));
  if ((input.size != null && fs.statSync(file).size !== input.size) || await sha256File(file) !== digest) {
    throw new Error(`Homebrew bottle does not match the locked input: ${repository}`);
  }
  return { file, url: input.url, sha256: digest };
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
  const inputs = await Promise.all([binary ?? source, ...additional].map((input) => fetchInput(input, work)));
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
    run('bash', ['scripts/build-engine.sh', key, inputs[0].file, root, ...inputs.slice(1).map(({ file }) => file)], {
      env: { ...process.env, MARINA_BUILD_VERSION: version },
    });
  }

  if (key === 'qdrant' && !fs.existsSync(path.join(root, 'LICENSE'))) {
    fs.copyFileSync(inputs[1].file, path.join(root, 'LICENSE'));
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

  const macOpenSSL = inputs.find(({ url }) => url.startsWith('https://ghcr.io/v2/homebrew/core/openssl/1.1/blobs/'));
  if (key === 'mysql' && process.platform === 'darwin' && macOpenSSL) {
    const compat = path.join(work, 'openssl-compat');
    fs.mkdirSync(compat);
    run('tar', ['-xf', macOpenSSL.file, '-C', compat]);
    const libs = ['libcrypto.1.1.dylib', 'libssl.1.1.dylib'];
    const opensslRoot = discoverRoot(compat, ['lib/' + libs[0]]);
    if (!opensslRoot) throw new Error('OpenSSL bottle is missing its runtime libraries');
    for (const library of libs) {
      fs.copyFileSync(path.join(opensslRoot, 'lib', library), path.join(root, 'lib', library), fs.constants.COPYFILE_EXCL);
    }
    fs.copyFileSync(path.join(opensslRoot, 'LICENSE'), path.join(root, 'LICENSE-OpenSSL-1.1'));
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
  const archive = path.join(out, archiveName(target));
  run('tar', [windows ? '-acf' : '-czf', archive, '-C', moved, '.']);
  console.log(archive);
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
