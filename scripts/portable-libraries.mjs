import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { sha256File } from '../src/install/download.js';

function command(bin, args, env = process.env) {
  return execFileSync(bin, args, { env, encoding: 'utf8' });
}

function filesIn(root) {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) return filesIn(file);
    return entry.isFile() ? [file] : [];
  });
}

function local(file, root) {
  const relative = path.relative(root, file);
  return relative !== '' && relative !== '..' && !relative.startsWith('../') && !path.isAbsolute(relative);
}

function nativeFiles(root) {
  const macho = new Set(['feedface', 'feedfacf', 'cefaedfe', 'cffaedfe', 'cafebabe', 'cafebabf']);
  return filesIn(root).filter((file) => {
    const header = Buffer.alloc(4);
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, header); } finally { fs.closeSync(fd); }
    const key = header.toString('hex');
    return process.platform === 'darwin' ? macho.has(key) : key === '7f454c46';
  });
}

const darwinSystem = /^\/(?:usr\/lib|System\/Library|Library\/Apple\/System\/Library)\//;
const linuxSystem = /^(?:ld-linux[^/]*|lib(?:c|m|pthread|dl|rt|resolv|util|gcc_s|stdc\+\+|ssl|crypto))\.so(?:\.\d+)*$/;

function linuxLibraryLicense(file) {
  // Ubuntu's loader returns /lib paths even for packages registered under /usr/lib.
  const query = fs.realpathSync(file).replace(/^\/usr\/lib\//, '*/lib/');
  const owner = command('dpkg-query', ['-S', query]).split(': ')[0];
  return path.join('/usr/share/doc', owner.split(':')[0], 'copyright');
}

function machDependencies(file) {
  return [...new Set(command('otool', ['-L', file]).split('\n')
    .map((line) => line.match(/^\s+(.+?) \(compatibility version/)?.[1]).filter(Boolean))];
}

function machRpaths(file) {
  return [...new Set([...command('otool', ['-l', file]).matchAll(/cmd LC_RPATH\s+cmdsize \d+\s+path (.+?) \(offset \d+\)/g)]
    .map((match) => match[1]))];
}

function machLocal(ref, file, root) {
  const dir = path.dirname(file);
  return ref.replace(/^@loader_path\b/, dir).replace(/^@executable_path\b/, path.join(root, 'bin'));
}

function relocateMac(root) {
  const files = nativeFiles(root);
  for (const file of files) {
    const deps = machDependencies(file);
    const rpaths = machRpaths(file);
    const changes = [];
    for (const dep of deps) {
      // Homebrew bottles use a relocation marker for both their own libraries
      // and runtime dependencies supplied with the package.
      const bottleLibrary = /^@@HOMEBREW_PREFIX@@\/opt\/[^/]+\/lib\/([^/]+)$/.exec(dep)?.[1];
      const target = bottleLibrary ? path.join(root, 'lib', bottleLibrary) : dep;
      if (local(target, root) && fs.existsSync(target)) {
        changes.push('-change', dep, '@loader_path/' + path.relative(path.dirname(file), target));
      } else if (dep.startsWith('@rpath/') && !rpaths.some((ref) => {
        const candidate = path.resolve(machLocal(ref, file, root), dep.slice(7));
        return (local(candidate, root) || darwinSystem.test(candidate)) && fs.existsSync(candidate);
      })) {
        const suffix = '/' + dep.slice(7);
        const candidates = files.filter((item) => item.endsWith(suffix));
        // Install names can point at a symlink such as libpq.5.dylib.
        for (const lib of ['lib', 'lib/mariadb', 'lib/private']) {
          const candidate = path.join(root, lib, dep.slice(7));
          if (fs.existsSync(candidate)) candidates.push(candidate);
        }
        const target = candidates[0];
        if (target) changes.push('-change', dep, '@loader_path/' + path.relative(path.dirname(file), target));
      }
    }
    for (const ref of rpaths) {
      if (ref.startsWith('@@HOMEBREW_PREFIX@@/') || (path.isAbsolute(ref) && !darwinSystem.test(ref + '/'))) {
        changes.push('-delete_rpath', ref);
        if (local(ref, root) && !rpaths.includes('@loader_path/' + path.relative(path.dirname(file), ref))) {
          changes.push('-add_rpath', '@loader_path/' + path.relative(path.dirname(file), ref));
        }
      }
    }
    if (changes.length) {
      command('install_name_tool', [...changes, file]);
      command('codesign', ['--force', '--sign', '-', file]);
    }
  }
}

function dynamicElf(file) {
  return /\(NEEDED\)|\((?:RUNPATH|RPATH)\)/.test(command('readelf', ['-d', file]));
}

function elfDeps(file, env) {
  return command('ldd', [file], env).split('\n').flatMap((line) => {
    const match = line.trim().match(/^(\S+)\s+=>\s+(not found|\/.*?)\s*(?:\(0x[0-9a-f]+\))?\s*$/);
    return match ? [{ name: match[1], file: match[2] }] : [];
  });
}

async function relocateLinux(root) {
  const files = nativeFiles(root).filter(dynamicElf);
  const libraries = path.join(root, 'lib', 'marina');
  const env = { ...process.env, LD_LIBRARY_PATH: ['lib', 'lib64', 'lib/private', 'lib/mariadb'].map((dir) => path.join(root, dir)).join(':') };
  const added = new Map();
  const missing = new Set();
  for (const file of files) {
    for (const dep of elfDeps(file, env)) {
      if (dep.file === 'not found') {
        missing.add(dep.name + ' required by ' + path.relative(root, file));
        continue;
      }
      if (linuxSystem.test(dep.name) || local(dep.file, root)) continue;
      const name = path.basename(dep.name);
      const copy = path.join(libraries, name);
      if (added.get(name) === dep.file) continue;
      if (fs.existsSync(copy) && await sha256File(copy) !== await sha256File(dep.file)) {
        throw new Error('conflicting dependency ' + dep.name);
      }
      fs.mkdirSync(libraries, { recursive: true });
      fs.copyFileSync(dep.file, copy);
      const copyright = linuxLibraryLicense(dep.file);
      if (fs.existsSync(copyright)) fs.copyFileSync(copyright, path.join(libraries, 'LICENSE-' + name));
      added.set(name, dep.file);
    }
  }
  if (missing.size) throw new Error('missing libraries: \n' + [...missing].join('\n'));
  for (const file of [...files, ...[...added.keys()].map((name) => path.join(libraries, name))]) {
    const previous = command('patchelf', ['--print-rpath', file]).trim();
    const keep = previous.split(':').filter((ref) => /^\$\{?ORIGIN\}?($|\/)/.test(ref));
    const own = [libraries, path.join(root, 'lib'), path.join(root, 'lib64')].filter(fs.existsSync)
      .map((dir) => '$ORIGIN/' + (path.relative(path.dirname(file), dir) || '.'));
    const rpath = [...new Set([...keep, ...own])].join(':');
    if (rpath !== previous) command('patchelf', ['--set-rpath', rpath, file]);
  }
}

export async function relocate(root) {
  if (process.platform === 'darwin') relocateMac(root);
  if (process.platform === 'linux') await relocateLinux(root);
}

export function verifyLibraries(root) {
  if (process.platform === 'win32') return;
  const failures = [];
  for (const file of nativeFiles(root)) {
    if (process.platform === 'linux') {
      if (!dynamicElf(file)) continue;
      for (const dep of elfDeps(file)) {
        if (dep.file === 'not found' || (!linuxSystem.test(dep.name) && !local(dep.file, root))) {
          failures.push(path.relative(root, file) + ': ' + dep.name + ' (' + dep.file + ')');
        }
      }
    } else {
      const rpaths = machRpaths(file);
      const id = command('otool', ['-D', file]).split('\n')[1]?.trim();
      for (const dep of machDependencies(file)) {
        if (dep === id || darwinSystem.test(dep)) continue;
        const candidates = dep.startsWith('@rpath/')
          ? rpaths.map((ref) => path.resolve(machLocal(ref, file, root), dep.slice(7)))
          : [machLocal(dep, file, root)];
        if (!dep.startsWith('@') || !candidates.some((candidate) =>
          darwinSystem.test(candidate) || (local(candidate, root) && fs.existsSync(candidate)))) {
          failures.push(path.relative(root, file) + ': ' + dep);
        }
      }
    }
  }
  if (failures.length) throw new Error('non-relocatable dependencies:\n' + failures.join('\n'));
}
