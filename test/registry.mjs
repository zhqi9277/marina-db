// Engine registry: reference parsing, installed-version resolution and context.
// Spins up a fake engines tree in an isolated MARINA_HOME (directories only).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'marina-registry-'));
process.env.MARINA_HOME = HOME;

const registry = await import('../src/registry.js');
const state = await import('../src/state.js');
const { engines, engineList } = registry;

const versionPath = (key, major, version) => path.join(HOME, 'engines', key, major, version);
fs.mkdirSync(versionPath('mysql', '8.0', '8.0.29'), { recursive: true });
fs.mkdirSync(versionPath('mysql', '8.4', '8.4.9'), { recursive: true });
fs.mkdirSync(versionPath('mysql', '8.4', '8.4.11'), { recursive: true });
// a stray file inside the majors tree must not be mistaken for a version
fs.writeFileSync(path.join(HOME, 'engines', 'mysql', '8.4', 'README.md'), 'not a version');

after(() => fs.rmSync(HOME, { recursive: true, force: true }));

test('getEngine is case-insensitive and lists known engines in its error', () => {
  assert.equal(registry.getEngine('MySQL').key, 'mysql');
  assert.equal(registry.getEngine('redis').key, 'redis');
  assert.equal(engineList.length, 6);
  assert.deepEqual(engineList.map((e) => e.key).sort(), ['mariadb', 'memcached', 'mongodb', 'mysql', 'postgres', 'redis']);

  assert.throws(() => registry.getEngine('oracle'), (e) => {
    assert.match(e.message, /unknown database "oracle"/);
    for (const key of Object.keys(engines)) assert.ok(e.message.includes(key), `error should mention ${key}`);
    return true;
  });
});

test('parseRef splits engine and optional tag', () => {
  assert.throws(() => registry.parseRef(''), /missing database name/);
  assert.throws(() => registry.parseRef(null), /missing database name/);

  assert.deepEqual(registry.parseRef('mysql@8.4.11').tag, '8.4.11');
  assert.deepEqual(registry.parseRef('mysql@').tag, null);
  assert.equal(registry.parseRef('postgres@17').engine.key, 'postgres');
  // "@" inside the tag is preserved
  assert.equal(registry.parseRef('mysql@weird@tag').tag, 'weird@tag');
});

test('installedVersions lists directories only and sorts numerically', () => {
  const rows = registry.installedVersions(engines.mysql);
  assert.deepEqual(rows.map((r) => r.version), ['8.0.29', '8.4.9', '8.4.11']);
  assert.deepEqual(rows.map((r) => r.major), ['8.0', '8.4', '8.4']);
  assert.equal(rows[2].dir, versionPath('mysql', '8.4', '8.4.11'));

  assert.deepEqual(registry.installedVersions(engines.redis), []);
});

test('isInstalled checks the version directory', () => {
  assert.equal(registry.isInstalled(engines.mysql, '8.4', '8.4.11'), true);
  assert.equal(registry.isInstalled(engines.mysql, '8.4', '8.4.99'), false);
  assert.equal(registry.isInstalled(engines.redis, '7', '7.4.11'), false);
});

test('pickVersion falls back from exact tag to active, latest and major', () => {
  assert.equal(registry.pickVersion(engines.redis, null), null);
  // no active version yet -> newest installed
  assert.equal(registry.pickVersion(engines.mysql, null).version, '8.4.11');

  state.setActive('mysql', '8.4.9');
  assert.equal(registry.pickVersion(engines.mysql, null).version, '8.4.9');
  assert.equal(registry.pickVersion(engines.mysql, '8.4.9').version, '8.4.9');
  // major line prefers the active version inside it
  assert.equal(registry.pickVersion(engines.mysql, '8.4').version, '8.4.9');
  // a bare "8" is not a major line, so it is treated as a version prefix
  assert.equal(registry.pickVersion(engines.mysql, '8').version, '8.4.11');
  assert.equal(registry.pickVersion(engines.mysql, '8.4.1'), null);
  assert.equal(registry.pickVersion(engines.mysql, '9'), null);
});

test('buildCtx wires paths, account and port for each engine shape', () => {
  const mysql = registry.buildCtx(engines.mysql, { major: '8.4', version: '8.4.11', port: '4567' });
  assert.equal(mysql.key, 'mysql');
  assert.equal(mysql.port, 4567);
  assert.equal(mysql.root, null); // payload not present in the fake tree
  assert.equal(mysql.confFile, path.join(HOME, 'etc', 'mysql', '8.4', 'my.cnf'));
  assert.equal(mysql.sockFile, path.join(HOME, 'run', 'mysql-8.4.sock'));
  assert.equal(mysql.pidFile, path.join(HOME, 'run', 'mysql-8.4.pid'));
  assert.equal(mysql.logFile, path.join(HOME, 'logs', 'mysql', '8.4.log'));
  assert.equal(mysql.dataDir, path.join(HOME, 'data', 'mysql', '8.4'));
  assert.deepEqual({ user: mysql.user, password: mysql.password }, { user: 'root', password: 'root' });

  // postgres owns no marina-generated conf file and defaults to 5432
  const pg = registry.buildCtx(engines.postgres, { major: '17', version: '17.11' });
  assert.equal(pg.confFile, null);
  assert.equal(pg.port, 5432);
  assert.equal(pg.sockFile, path.join(HOME, 'run', 'postgres-17.sock'));

  const redis = registry.buildCtx(engines.redis, { major: '7', version: '7.4.11' });
  assert.equal(redis.port, 6379);
  assert.equal(redis.confFile, path.join(HOME, 'etc', 'redis', '7', 'redis.conf'));
});

test('resolveRef reports installed versions and honours requireInstalled', () => {
  const hit = registry.resolveRef('mysql@8.4.11');
  assert.equal(hit.installed, true);
  assert.equal(hit.version, '8.4.11');
  assert.equal(hit.ctx.version, '8.4.11');

  assert.throws(() => registry.resolveRef('mysql@9.9'), (e) => {
    assert.match(e.message, /MySQL 9\.9 is not installed \(installed: 8\.0\.29, 8\.4\.9, 8\.4\.11\)/);
    assert.match(e.message, /hint: marina install mysql@9\.9/);
    return true;
  });
  assert.throws(() => registry.resolveRef('redis@7'), /Redis 7 is not installed \(installed: none\)/);

  const soft = registry.resolveRef('redis@7', { requireInstalled: false });
  assert.equal(soft.installed, false);
  assert.equal(soft.ctx, null);
  assert.equal(soft.engine.key, 'redis');
});

test('activeCtx reflects the active version and is null when nothing is installed', () => {
  assert.equal(registry.activeCtx(engines.mysql).version, '8.4.9');
  assert.equal(registry.activeCtx(engines.redis), null);
});

test('syncCurrentSymlink points current at the version and is idempotent', { skip: process.platform === 'win32' }, () => {
  const link = path.join(HOME, 'engines', 'mysql', '8.4', 'current');
  registry.syncCurrentSymlink(engines.mysql, '8.4', '8.4.11');
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  assert.equal(fs.realpathSync(link), fs.realpathSync(versionPath('mysql', '8.4', '8.4.11')));

  // a second call replaces, rather than nests, the existing link
  registry.syncCurrentSymlink(engines.mysql, '8.4', '8.4.9');
  assert.equal(fs.realpathSync(link), fs.realpathSync(versionPath('mysql', '8.4', '8.4.9')));

  // real directory at the link path is replaced as well
  fs.rmSync(link, { force: true });
  fs.mkdirSync(link);
  fs.writeFileSync(path.join(link, 'junk'), 'x');
  registry.syncCurrentSymlink(engines.mysql, '8.4', '8.4.11');
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  assert.equal(fs.existsSync(path.join(link, 'junk')), false);
});

test('syncCurrentSymlink does nothing when the target version is absent', () => {
  const link = path.join(HOME, 'engines', 'mysql', '8.0', 'current');
  registry.syncCurrentSymlink(engines.mysql, '8.0', '8.0.99');
  assert.equal(fs.existsSync(link), false);
});

test('ensureVersionDirs creates the engine/etc/data/log skeleton', () => {
  registry.ensureVersionDirs(engines.mysql, '8.0');
  for (const dir of [
    path.join(HOME, 'engines', 'mysql', '8.0'),
    path.join(HOME, 'etc', 'mysql', '8.0'),
    path.join(HOME, 'data', 'mysql', '8.0'),
    path.join(HOME, 'logs', 'mysql'),
  ]) {
    assert.equal(fs.statSync(dir).isDirectory(), true, `missing directory ${dir}`);
  }
});
