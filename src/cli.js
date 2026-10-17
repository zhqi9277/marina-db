// marina CLI: argument parsing, commands, rendering.
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { dirs } from './paths.js';
import { engineList, getEngine, installedVersions, buildCtx, activeCtx, resolveRef, pickVersion, syncCurrentSymlink } from './registry.js';
import { status, start, stop, restart, stateBadge } from './lifecycle.js';
import { install, remove, use, renderConfig } from './installer.js';
import { listVersions } from './versions.js';
import { installShims, resolveBin, shellenv } from './shims.js';
import { readProject } from './project.js';
import { findBin } from './archive.js';
import { OS_LABEL } from './platform.js';
import { runDoctor } from './doctor.js';
import * as state from './state.js';
import {
  out, info, ok, warn, fail, hint, table, jsonOut, color, isInteractive, select,
} from './ui.js';

const HELP = `marina — multi-engine database manager (version switch + service lifecycle)

USAGE
  marina <command> [database[@version]] [flags]
  marina                          interactive menu (TTY only)

DATABASES
  mysql, mariadb, postgres, mongodb, redis, memcached

INSTALL / SWITCH
  marina remote                   every version the mirrors / upstream expose
  marina remote mysql             full version list for one database
  marina remote mysql --refresh   re-query the index (cache ttl 6h)
  marina install mysql@8.4        download, unpack, init datadir, wire config
  marina install mysql            pick a version from the list (TTY)
  marina install redis --port 6380
  marina install mysql@8.4.11 --file ./mysql-8.4.11-macos15-arm64.tar.gz
  marina use mysql@8.4            switch active version
  marina use                      apply pins from ./.marinarc
  marina current                  show active versions (+ project pins)
  marina ls                       installed versions and their state

SERVICE
  marina start|stop|restart <db[@ver]>      (aliases: up / down)
  marina up --all                  every installed database
  marina status [db[@ver]]        state, port, pid
  marina logs <db[@ver]> [--lines 60]
  marina config <db[@ver]>        config file path
  marina port <db[@ver]> [N]      read or change the port

TOOLS
  marina exec <db[@ver]> -- -e "select 1"    run the client of that version
  marina which mysql                          resolve a client binary
  marina shims                                install ~/.marina/shims/*
  marina shellenv                             eval "$(marina shellenv)"
  marina reconfig [<db[@ver]>|--all]  rewrite generated config + current symlink
  marina rm <db[@ver]> [--purge]
  marina doctor
  marina            (no args, TTY) full-screen dashboard

FLAGS
  --json   machine-readable output      --force   rewrite config / re-extract
  --all    every installed database     --purge   delete the datadir too
  --refresh  re-query the remote index  --use / --no-use  switch active after install
  --major 8.0  --installed             filter the remote version list
  --port N --file path --version v --lines N

ENV
  MARINA_HOME            install root (default ~/.marina)
  MARINA_MIRROR          index/download order, e.g. huawei,aliyun (default: aliyun,tencent,huawei)
  MARINA_INDEX_TTL       version-index cache seconds (default 21600)
  MARINA_CATALOG_FILE    optional self-built artifact overlay (JSON)
  MARINA_CATALOG_URL     same, fetched over HTTP

HOMEPAGE
  https://gitee.com/zhqi9277/marina
`;

const VALUE_FLAGS = new Set(['port', 'file', 'version', 'lines', 'bin', 'major']);

function splitArgv(argv) {
  const idx = argv.indexOf('--');
  return {
    head: idx >= 0 ? argv.slice(0, idx) : argv,
    tail: idx >= 0 ? argv.slice(idx + 1) : [],
  };
}

function parseFlags(tokens) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '-h') {
      flags.help = true;
    } else if (t.startsWith('--')) {
      const eq = t.indexOf('=');
      const rawKey = eq >= 0 ? t.slice(2, eq) : t.slice(2);
      let val = eq >= 0 ? t.slice(eq + 1) : undefined;
      const key = rawKey.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      if (val === undefined && VALUE_FLAGS.has(key) && tokens[i + 1] && !tokens[i + 1].startsWith('-')) {
        val = tokens[++i];
      }
      flags[key] = val === undefined ? true : val;
    } else {
      rest.push(t);
    }
  }
  return { flags, rest };
}

function requireRef(args, flags, { fallback = null } = {}) {
  const ref = args[0] || fallback;
  if (!ref) throw new Error('missing database — e.g. marina status mysql@8.4');
  return ref;
}

function renderServices(rows) {
  if (!rows.length) return null;
  return table(
    ['DATABASE', 'VERSION', 'STATE', 'PORT', 'ACTIVE'],
    rows.map((r) => [
      r.label,
      r.version,
      stateBadge(r.state),
      String(r.port),
      r.active ? color.cyan('*') : '',
    ]),
    { align: ['left', 'left', 'left', 'right', 'left'] },
  );
}

// Only one version per major line can run (same socket/port/config), so runtime
// state is probed once per major and other versions are reported as inactive.
async function versionStatus(engine, v, activePick) {
  const anotherActiveInMajor = activePick && activePick.major === v.major && activePick.version !== v.version;
  if (anotherActiveInMajor) {
    const activeStat = await status(buildCtx(engine, activePick));
    return {
      ...activeStat,
      version: v.version,
      active: false,
      pid: null,
      state: activeStat.state === 'running' ? 'inactive' : activeStat.state,
    };
  }
  const st = await status(buildCtx(engine, v));
  return { ...st, version: v.version, active: !!(activePick && activePick.version === v.version) };
}

async function collectRows() {
  const rows = [];
  for (const engine of engineList) {
    const versions = installedVersions(engine);
    if (!versions.length) continue;
    const activeVersion = state.getActive(engine.key);
    const activePick = activeVersion ? versions.find((v) => v.version === activeVersion) : versions[versions.length - 1];
    for (const v of versions) {
      const st = await versionStatus(engine, v, activePick);
      rows.push({ ...st, label: engine.label, major: v.major, ctx: buildCtx(engine, v) });
    }
  }
  return rows;
}

// ---------------------------------------------------------------- commands --
async function cmdLs(flags) {
  const rows = await collectRows();
  if (flags.json) {
    return jsonOut(rows.map(({ ctx, ...r }) => ({ ...r, auth: ctx.engine.account?.(ctx) || null })));
  }
  if (!rows.length) {
    info('nothing installed yet');
    hint('try: marina remote mysql   then: marina install mysql@8.4');
    return;
  }
  out(renderServices(rows));
  const missing = engineList.filter((e) => !installedVersions(e).length).map((e) => e.key);
  if (missing.length) {
    out('');
    hint(`not installed: ${missing.join(', ')} — marina remote <db>`);
  }
}

async function cmdRemote(flags, args) {
  const engine = args[0] ? getEngine(args[0]) : null;
  const targets = engine ? [engine] : engineList;
  const indexes = [];

  for (const e of targets) {
    try {
      indexes.push({ ...(await listVersions(e.key, { refresh: !!flags.refresh })), engine: e });
    } catch (err) {
      warn(`${e.label}: ${err.message.split('\n')[0]}`);
    }
  }
  if (!indexes.length) throw new Error('no version index is reachable — check the network, then: marina remote --refresh');

  if (flags.json) {
    const data = {};
    for (const { engine: e, source, fetchedAt, stale, versions } of indexes) {
      const installed = new Set(installedVersions(e).map((r) => r.version));
      const active = state.getActive(e.key);
      data[e.key] = {
        source,
        fetchedAt,
        stale: !!stale,
        versions: versions.map((v) => ({
          version: v.version,
          major: v.major,
          kind: v.kind,
          source: v.source,
          supported: !!v.supported,
          reason: v.reason || null,
          url: v.urls?.[0] || null,
          installed: installed.has(v.version),
          active: active === v.version,
        })),
      };
    }
    return jsonOut(engine ? data[engine.key] : data);
  }

  if (!engine) {
    const rows = indexes.map(({ engine: e, source, versions }) => {
      const installed = installedVersions(e).map((r) => r.version);
      const newest = versions.slice(0, 3).map((v) => v.version).join(', ');
      return [e.label, String(versions.length), newest || '—', installed.join(', ') || '—', source];
    });
    out(table(['DATABASE', 'VERSIONS', 'NEWEST', 'INSTALLED', 'INDEX'], rows));
    hint('full list: marina remote <db>   ·   refresh: marina remote --refresh');
    hint('versions are discovered remotely (mirrors first, official upstream as fallback)');
    return;
  }

  const idx = indexes[0];
  const installed = new Set(installedVersions(engine).map((r) => r.version));
  const active = state.getActive(engine.key);
  let versions = idx.versions;
  if (flags.major) {
    const major = String(flags.major);
    versions = versions.filter((v) => v.major === major || v.major === major.split('.')[0]);
  }
  if (flags.installed) versions = versions.filter((v) => installed.has(v.version));

  const rows = versions.map((v) => [
    v.version,
    v.kind === 'source' ? color.yellow('source') : color.green('binary'),
    v.supported ? '' : color.red(`n/a`),
    v.source,
    installed.has(v.version) ? color.green('installed') : '',
    active === v.version ? color.cyan('*') : '',
  ]);
  out(table([`${engine.label.toUpperCase()} VERSION`, 'KIND', 'PLATFORM', 'INDEX', 'INSTALLED', 'ACTIVE'], rows));
  hint(`index: ${idx.source}${idx.stale ? ' (stale cache)' : ''} · ${idx.versions.length} versions listed`);
  hint(`install: marina install ${engine.key}@${versions[0]?.version || '<version>'}`);
}

async function cmdInstall(flags, args) {
  const ref = requireRef(args, flags);
  const [key, ...tagParts] = ref.split('@');
  const engine = getEngine(key);
  const tag = tagParts.join('@') || null;

  let target = ref;
  if (!tag && !flags.file) {
    const idx = await listVersions(engine.key);
    const usable = idx.versions.filter((v) => v.supported);
    const pool = usable.length ? usable : idx.versions;
    if (!pool.length) throw new Error(`${engine.label}: the remote index returned no versions`);
    if (!isInteractive()) {
      throw new Error(
        `missing version — e.g. marina install ${engine.key}@${pool[0].version}\n  (run in a TTY to pick from ${pool.length} versions)`,
      );
    }
    const { item } = await select(
      `${engine.label} — choose a version`,
      pool.slice(0, 30).map((v) => ({
        label: v.version,
        hint: `${v.kind} · ${v.source}${v.supported ? '' : ` · n/a on ${OS_LABEL}`}`,
      })),
    );
    target = `${engine.key}@${item.label}`;
  }

  const summary = await install(target, {
    port: flags.port ? Number(flags.port) : null,
    force: !!flags.force,
    file: flags.file || null,
    version: flags.version || null,
    use: !flags.noUse,
  });
  if (flags.json) return jsonOut(summary);
  out('');
  ok(`${summary.label} ${summary.version} installed (${summary.source})`);
  hint(`data    ${summary.dataDir}`);
  if (summary.confFile) hint(`config  ${summary.confFile}`);
  hint(`start   marina start ${summary.key}@${summary.major}`);
}

async function cmdUse(flags, args) {
  if (!args.length) {
    const project = readProject();
    if (!project) throw new Error('no .marinarc found here — marina use mysql@8.4');
    const applied = [];
    for (const [key, ver] of Object.entries(project.pins)) {
      const engine = getEngine(key);
      const pick = pickVersion(engine, String(ver));
      if (!pick) {
        warn(`${key}@${ver} from ${project.file} is not installed — skipped`);
        continue;
      }
      await use(`${key}@${pick.version}`, { restart: false, quiet: true });
      applied.push(`${key} -> ${pick.version}`);
    }
    if (flags.json) return jsonOut({ file: project.file, applied });
    applied.forEach((a) => ok(a));
    hint(`from ${project.file}`);
    return;
  }
  const res = await use(args[0], { restart: !!flags.restart });
  if (flags.json) return jsonOut({ key: res.engine.key, version: res.version, previous: res.previous });
  ok(`active ${res.engine.key} -> ${res.version}`);
  if (res.previous && res.previous !== res.version && !flags.restart) {
    hint(`was ${res.previous} — restart to apply: marina restart ${res.engine.key}@${res.version.split('.').slice(0, 2).join('.')}`);
  }
}

async function cmdCurrent(flags) {
  const project = readProject();
  const rows = engineList.map((e) => {
    const active = state.getActive(e.key);
    const pin = project?.pins?.[e.key] ? String(project.pins[e.key]) : null;
    return [e.label, active || color.gray('—'), pin || '', String(e.defaultPort)];
  });
  if (flags.json) {
    return jsonOut({
      home: dirs.root,
      active: state.load().active,
      project: project ? { file: project.file, pins: project.pins } : null,
    });
  }
  out(table(['DATABASE', 'ACTIVE', 'PROJECT PIN', 'DEFAULT PORT'], rows));
  if (project) hint(`project: ${project.file}`);
}

async function lifecycleMany(flags, action, args) {
  let targets = [];
  if (flags.all) {
    targets = engineList
      .map((e) => activeCtx(e))
      .filter(Boolean);
  } else {
    const ref = requireRef(args, flags);
    targets = [resolveRef(ref).ctx];
  }
  if (!targets.length) {
    warn('nothing installed — marina install mysql@8.4');
    return;
  }
  const results = [];
  for (const ctx of targets) {
    const r = await (action === 'start' ? start(ctx) : action === 'stop' ? stop(ctx) : restart(ctx));
    const st = await status(ctx);
    results.push({ ...st, label: ctx.engine.label });
  }
  if (flags.json) return jsonOut(results);
  out('');
  out(renderServices(results.map((r) => ({ ...r, active: true }))));
}

async function cmdStatus(flags, args) {
  if (args[0]) {
    const { engine, ctx } = resolveRef(args[0]);
    const versions = installedVersions(engine);
    const activeVersion = state.getActive(engine.key);
    const activePick = versions.find((v) => v.version === activeVersion) || versions[versions.length - 1];
    const st = await versionStatus(engine, versions.find((v) => v.version === ctx.version), activePick);
    const acct = ctx.engine.account?.(ctx) || null;
    if (flags.json) return jsonOut({ ...st, auth: acct });
    out(renderServices([{ ...st, label: engine.label }]));
    hint(`data ${ctx.dataDir}${ctx.confFile ? `   config ${ctx.confFile}` : ''}`);
    if (acct) {
      hint(`auth ${acct.user || '—'}${acct.password ? ` / ${acct.password}` : `   (${acct.mode})`}`);
    }
    return;
  }
  const rows = await collectRows();
  if (flags.json) {
    return jsonOut(rows.map(({ ctx, ...r }) => ({ ...r, auth: ctx.engine.account?.(ctx) || null })));
  }
  if (!rows.length) return info('nothing installed yet');
  out(renderServices(rows));
}

async function cmdLogs(flags, args) {
  const { ctx } = resolveRef(requireRef(args, flags));
  const lines = Number(flags.lines || 60);
  const file = ctx.logFile;
  if (!fs.existsSync(file)) return warn(`no log yet at ${file}`);
  const content = fs.readFileSync(file, 'utf8').trimEnd().split('\n');
  out(content.slice(-lines).join('\n'));
}

async function cmdConfig(flags, args) {
  const { ctx } = resolveRef(requireRef(args, flags));
  if (!ctx.confFile) return info('this engine has no marina-managed config file');
  out(ctx.confFile);
  if (!fs.existsSync(ctx.confFile)) warn('file does not exist yet — marina install --force');
}

async function cmdPort(flags, args) {
  const ref = requireRef(args, flags);
  const { engine, tag } = { engine: getEngine(ref.split('@')[0]), tag: ref.split('@')[1] || null };
  const pick = pickVersion(engine, tag);
  const major = pick?.major || tag || engine.defaultMajor;
  if (args[1] || (flags.port && flags.port !== true)) {
    const value = Number(args[1] || flags.port);
    if (!Number.isInteger(value) || value <= 0 || value > 65535) throw new Error('port must be 1..65535');
    state.setPort(engine.key, major, value);
    ok(`port ${engine.key}@${major} -> ${value}`);
    hint(`apply with: marina reconfig ${engine.key}@${major} && marina restart ${engine.key}@${major}`);
    return;
  }
  out(String(state.portOf(engine.key, major, engine.defaultPort)));
}

async function cmdReconfig(flags, args) {
  const targets = flags.all
    ? engineList.map((e) => activeCtx(e)).filter(Boolean)
    : [resolveRef(requireRef(args, flags)).ctx];
  if (!targets.length) return warn('nothing installed');
  const done = [];
  for (const ctx of targets) {
    const active = state.getActive(ctx.engine.key) || ctx.version;
    syncCurrentSymlink(ctx.engine, ctx.major, active);
    const r = renderConfig(ctx, { force: true });
    done.push({ key: ctx.key, version: ctx.version, confFile: r.path || null });
  }
  if (flags.json) return jsonOut(done);
  done.forEach((d) => ok(`${d.key} ${d.version}${d.confFile ? ` -> ${d.confFile}` : ''}`));
  hint('restart running services to pick up new paths: marina restart <db>');
}

async function cmdRm(flags, args) {
  const res = await remove(requireRef(args, flags), { purge: !!flags.purge });
  if (flags.json) return jsonOut({ key: res.engine.key, version: res.pick.version, purged: res.purged });
  ok(`removed ${res.engine.key} ${res.pick.version}`);
  if (res.purged) hint(`datadir purged: ${dirs.data}/${res.engine.key}/${res.pick.major}`);
  else hint('datadir kept — add --purge to delete it');
  if (res.remaining.length) hint(`still installed: ${res.remaining.map((r) => r.version).join(', ')}`);
}

function cmdWhich(args, flags) {
  const bin = args[0];
  if (!bin) throw new Error('usage: marina which <binary>');
  const found = resolveBin(bin);
  if (!found) throw new Error(`${bin} is not provided by any active database version`);
  if (flags.json) return jsonOut({ bin, path: found.path, database: found.engine.key, version: found.ctx.version });
  out(found.path);
}

function cmdExec(flags, args, tail) {
  const ref = args[0];
  if (!ref) throw new Error('usage: marina exec mysql@8.4 -- -e "select 1"');
  const pass = [...args.slice(1), ...tail];
  const { engine, ctx } = resolveRef(ref);
  const binName = flags.bin || engine.primaryClient;
  const bin = findBin(ctx.root, [binName]);
  if (!bin) {
    throw new Error(`${engine.label} ${ctx.version} has no "${binName}" client binary\n  hint: try --bin ${(engine.clientBins || []).join(' | ')}`);
  }
  const isServer = (engine.serverBin || []).includes(binName);
  const prefix = !isServer && engine.clientArgs ? engine.clientArgs(ctx) : [];
  const child = spawn(bin, [...prefix, ...pass], { stdio: 'inherit' });
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (signal) process.kill(process.pid, signal);
      else process.exitCode = code ?? 0;
      resolve();
    });
  });
}

function cmdShimExec(args, tail) {
  const bin = args[0];
  const pass = [...args.slice(1), ...tail];
  const found = resolveBin(bin);
  if (!found) {
    fail(`${bin}: no active database provides this binary`);
    process.exit(127);
  }
  const isServer = (found.engine.serverBin || []).includes(bin);
  const prefix = !isServer && found.engine.clientArgs ? found.engine.clientArgs(found.ctx) : [];
  const child = spawn(found.path, [...prefix, ...pass], { stdio: 'inherit' });
  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 0);
  });
  return new Promise(() => {});
}

function cmdShims(flags) {
  const created = installShims();
  if (flags.json) return jsonOut(created);
  if (!created.length) {
    warn('nothing installed — marina install mysql@8.4');
    return;
  }
  ok(`${created.length} shims written to ${dirs.shims}`);
  const rows = created.slice(0, 12).map((c) => [c.bin, c.target]);
  out(table(['BIN', 'TARGET'], rows));
  hint('add to your shell:  eval "$(marina shellenv)"');
}

function cmdShellenv() {
  out(shellenv());
}

async function cmdDoctor(flags) {
  const checks = await runDoctor();
  if (flags.json) return jsonOut(checks);
  out(table(['CHECK', 'VALUE', ''], checks.map((c) => [c.name, c.value, c.ok ? color.green('ok') : color.red('fail')])));
}
async function cmdMenu() {
  if (!isInteractive()) throw new Error('the dashboard needs an interactive terminal — use a command instead (marina --help)');
  const { runTui } = await import('./tui/app.js');
  return runTui();
}

// -------------------------------------------------------------------- main --
export async function main(argv) {
  const { head, tail } = splitArgv(argv);
  const { flags, rest } = parseFlags(head);
  if (flags.help && !rest.length) return out(HELP);
  if (flags.version && !rest.length) return out('marina 0.1.0');

  const command = rest[0] || null;
  const args = rest.slice(1);

  // no command: menu on a TTY, help otherwise (never hang a pipe)
  if (!command) {
    if (isInteractive()) return cmdMenu();
    return out(HELP);
  }

  switch (command) {
    case 'help': return out(HELP);
    case 'ls':
    case 'list':
    case 'berths': return cmdLs(flags);
    case 'remote':
    case 'available': return cmdRemote(flags, args);
    case 'install':
    case 'i': return cmdInstall(flags, args);
    case 'use': return cmdUse(flags, args);
    case 'current': return cmdCurrent(flags);
    case 'start':
    case 'up': return lifecycleMany(flags, 'start', args);
    case 'stop':
    case 'down': return lifecycleMany(flags, 'stop', args);
    case 'restart': return lifecycleMany(flags, 'restart', args);
    case 'status': return cmdStatus(flags, args);
    case 'logs':
    case 'log': return cmdLogs(flags, args);
    case 'config': return cmdConfig(flags, args);
    case 'port': return cmdPort(flags, args);
    case 'reconfig':
      return cmdReconfig(flags, args);
    case 'rm':
    case 'uninstall':
    case 'remove': return cmdRm(flags, args);
    case 'which': return cmdWhich(args, flags);
    case 'exec': return cmdExec(flags, args, tail);
    case 'shim-exec': return cmdShimExec(args, tail);
    case 'shims': return cmdShims(flags);
    case 'shellenv': return cmdShellenv();
    case 'doctor': return cmdDoctor(flags);
    case 'menu':
    case 'tui':
    case 'ui': return cmdMenu();
    case 'version':
    case '--version':
      return out('marina 0.1.0');
    default:
      fail(`unknown command "${command}"`);
      out('');
      return out(HELP);
  }
}
