// Turn a directory of build artifacts into a marina manifest.
//
// Naming convention (what the CI matrix produces):
//   <engine>-<version>-<os>-<arch>.<ext>
//   redis-7.4.11-darwin-arm64.tar.gz
//   mysql-8.4.11-windows-x64.zip
//
// usage: node scripts/make-manifest.mjs dist/ > manifest.json
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const NAME = /^([a-z0-9]+)-(\d+\.\d+(?:\.\d+)?(?:-[A-Za-z0-9.]+)?)-(darwin|linux|windows)-(arm64|x64|x86_64|aarch64)\.(tar\.gz|tgz|zip|tar\.xz)$/;

export function sha256(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

export async function scan(dir, baseUrl) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const m = entry.name.match(NAME);
    if (!m) continue;
    const [, engine, version, osToken, arch, ext] = m;
    // node platform names: windows -> win32 (overlay compares these)
    const os = osToken === 'windows' ? 'win32' : osToken;
    const file = path.join(dir, entry.name);
    const stat = fs.statSync(file);
    out.push({
      name: engine,
      version,
      major: version.split('.').slice(0, 2).join('.'),
      os,
      arch,
      fileName: entry.name,
      size: stat.size,
      sha256: await sha256(file),
      url: `${baseUrl.replace(/\/+$/, '')}/${entry.name}`,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version) || a.os.localeCompare(b.os));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isMain) {
  const dir = process.argv[2] || 'dist';
  const base = process.env.MARINA_RELEASE_BASE || 'https://github.com/OWNER/REPO/releases/download/engines';
  const artifacts = await scan(dir, base);
  const manifest = {
    schema: 1,
    generatedAt: new Date().toISOString(),
    artifacts,
  };
  process.stdout.write(JSON.stringify(manifest, null, 2) + '\n');
  console.error(`[ok] ${artifacts.length} artifacts from ${dir}`);
}
