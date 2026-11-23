// marina CLI: argument parsing, commands, rendering.
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { dirs } from './core/paths.js';
import { engineList, getEngine, installedVersions, activeCtx, instanceContexts, resolveRef, pickVersion } from './core/registry.js';
import { collectRows, versionStatus } from './runtime/inventory.js';
import { status, start, stop, restart, stateBadge } from './runtime/lifecycle.js';
import { install, remove, use } from './install/installer.js';
import { listVersions, listVersionIndexes } from './install/versions.js';
import { installShims, resolveBin, shellenv } from './runtime/shims.js';
import { readProject } from './core/project.js';
import { changePort, changeAccount } from './runtime/settings.js';
import * as autostart from './runtime/autostart.js';
import { findBin } from './install/archive.js';
import { clientEnv } from './core/env.js';
import { runDoctor } from './runtime/doctor.js';
import * as state from './core/state.js';
import {
  out, info, ok, warn, fail, hint, table, jsonOut, color, isInteractive, select, isQuiet, setQuiet,
} from './ui/console.js';

const HELP = `marina — multi-engine database manager (version switch + service lifecycle)

USAGE
  marina <command> [database[@version]] [flags]
  marina                          interactive menu (TTY only)

DATABASES
  ${engineList.map(({ key }) => key).join(', ')}

INSTALL / SWITCH
  marina remote                   fetch the published builds for this host
  marina remote mysql             full version list for one database
  marina install mysql@8.4        download, unpack, init datadir, wire config
  marina install mysql            pick a version from the list (TTY)
  marina install redis --port 6380
  marina install mysql@8.4.11 --file ./mysql-8.4.11-macos15-arm64.tar.gz
  marina use mysql@8.4            switch active version
  marina use                      apply pins from ./.marinarc
  marina current                  show active versions (+ project pins)
  marina ls                       installed versions and their state

SERVICE
  marina start|stop|restart <db[@ver]>...   one or more refs (aliases: up / down)
  marina up --all                  every installed database
  marina status [db[@ver]]...     state, port, pid (one or more)
  marina logs <db[@ver]> [--lines 60]
  marina config <db[@ver]>        config file path
  marina port <db[@ver]> [N]      read/change the port (rewrites config, restarts)
  marina autostart [db...]        start at login (--all / --off)
  marina auth <db[@ver]> [u] [p]  show/store the connection account + password

TOOLS
  marina update                       sync the CLI checkout to GitHub main
  marina update --check               compare the local and GitHub commits
  marina exec <db[@ver]> -- -e "select 1"    run the client of that version
  marina which mysql                          resolve a client binary
  marina shims                                install shims into the runtime dir
  marina shellenv                             eval "$(marina shellenv)"
  marina rm <db[@ver]> [--purge]
  marina doctor
  marina            (no args, TTY) full-screen dashboard

FLAGS
  --json   machine-readable output      --force   rewrite config / re-extract
  --all    every installed database     --purge   delete the datadir too
  --use / --no-use  switch active after install
  --major 8.0  --installed             filter the remote version list
  --port N --file path --version v --lines N

ENV
  MARINA_HOME            install root (default <repo>/runtime, ~/.marina if read-only)
  MARINA_CATALOG_FILE    use a local build catalog (JSON)
  MARINA_CATALOG_URL     override the GitHub build catalog URL

HOMEPAGE
  https://github.com/zhqi9277/marina-db
`;

const VALUE_FLAGS = new Set(['port', 'file', 'version', 'lines', 'bin', 'major', 'user', 'password']);

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

// ---------------------------------------------------------------- commands --
async function cmdLs(flags) {
  const rows = await collectRows();
  if (flags.json) {
    return jsonOut(rows.map(({ ctx, engine, ...r }) => ({ ...r, auth: engine.account?.(ctx) || null })));
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
  const indexes = (await listVersionIndexes(targets.map((e) => e.key)))
    .map((index, i) => ({ ...index, engine: targets[i] }));

  if (flags.json) {
    const data = {};
    for (const { engine: e, source, fetchedAt, versions } of indexes) {
      const installed = new Set(installedVersions(e).map((r) => r.version));
      const active = state.getActive(e.key);
      data[e.key] = {
        source,
        fetchedAt,
        stale: false,
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
    const rows = indexes.map(({ engine: e, versions }) => {
      const installed = installedVersions(e).map((r) => r.version);
      const newest = versions.slice(0, 3).map((v) => v.version).join(', ');
      return [e.label, String(versions.length), newest || '—', installed.join(', ') || '—'];
    });
    out(table(['DATABASE', 'VERSIONS', 'NEWEST', 'INSTALLED'], rows));
    hint('full list: marina remote <db>');
    return;
  }

  const installed = new Set(installedVersions(engine).map((r) => r.version));
  const active = state.getActive(engine.key);
  let { versions } = indexes[0];
  if (flags.major) {
    const major = String(flags.major);
    versions = versions.filter((v) => v.major === major || v.major === major.split('.')[0]);
  }
  if (flags.installed) versions = versions.filter((v) => installed.has(v.version));

  if (!versions.length) {
    out('No matching versions');
    return;
  }
  for (const { version } of versions) {
    const marker = active === version ? color.cyan('->') : '  ';
    const label = installed.has(version) ? `${color.green(version)} (installed)` : version;
    out(`${marker} ${label}`);
  }
}

async function cmdInstall(flags, args) {
  const ref = requireRef(args, flags);
  const [key, ...tagParts] = ref.split('@');
  const engine = getEngine(key);
  const tag = tagParts.join('@') || null;

  let target = ref;
  if (!tag && !flags.file && !flags.version && isInteractive()) {
    const idx = await listVersions(engine.key);
    if (idx.versions.length) {
      const { item } = await select(
        `${engine.label} — choose a version`,
        idx.versions.slice(0, 30).map((v) => ({
          label: v.version,
          hint: v.source,
        })),
      );
      target = `${engine.key}@${item.label}`;
    }
  }

  const summary = await install(target, {
    port: flags.port ?? null,
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
    hint(`was ${res.previous} — restart to apply: marina restart ${res.engine.key}@${res.ctx.major}`);
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
  if (flags.autostart) {
    targets = state.autostartList()
      .map((id) => {
        try {
          return resolveRef(id.replace(':', '@')).ctx;
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    if (!targets.length) {
      if (flags.json) return jsonOut([]);
      warn('no autostart entries — marina autostart mysql@8.4');
      return;
    }
  } else if (flags.all) {
    targets = action === 'stop' ? engineList.flatMap(instanceContexts) : engineList.map(activeCtx).filter(Boolean);
  } else {
    // accept one or more refs: marina start mysql redis@7 postgres
    const refs = args.length ? args : [requireRef(args, flags)];
    const seen = new Set();
    targets = refs.map((ref) => {
      const { ctx } = resolveRef(ref);
      return { ...ctx, exactVersion: ref.split('@')[1] === ctx.version };
    }).filter((ctx) => {
      const id = `${ctx.key}:${ctx.major}`;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  }
  if (!targets.length) {
    if (flags.json) return jsonOut([]);
    warn('nothing installed — marina install mysql@8.4');
    return;
  }

  const results = [];
  const failures = [];
  for (const ctx of targets) {
    try {
      const opts = { instance: !ctx.exactVersion };
      await (action === 'start' ? start(ctx) : action === 'stop' ? stop(ctx, opts) : restart(ctx, opts));
      const st = await status(ctx);
      results.push({ ...st, label: ctx.engine.label });
    } catch (e) {
      failures.push({ key: ctx.key, major: ctx.major, error: String(e.message || e).split('\n')[0] });
      if (!flags.json) fail(`${ctx.key}@${ctx.major}: ${String(e.message || e).split('\n')[0]}`);
    }
  }

  if (flags.json) {
    if (failures.length) process.exitCode = 1;
    return jsonOut(failures.length ? { results, failures } : results);
  }
  if (results.length) {
    out('');
    out(renderServices(results.map((r) => ({ ...r, active: activeCtx(getEngine(r.key))?.version === r.version }))));
  }
  if (failures.length) {
    throw new Error(`${failures.length} of ${targets.length} ${action} target(s) failed`);
  }
}

async function cmdAutostart(flags, args) {
  const info = autostart.status();
  if (!info.supported) throw new Error('autostart is not available on this host');

  const refs = args.slice();
  let off = !!(flags.off || flags.disable);
  if (refs[0] === 'off' || refs[0] === 'disable') {
    off = true;
    refs.shift();
  } else if (refs[0] === 'on' || refs[0] === 'enable') {
    refs.shift();
  }

  const all = flags.all || (!refs.length && (off || flags.on));
  if (all || refs.length) {
    const ctxs = refs.length
      ? refs.map((ref) => resolveRef(ref).ctx)
      : engineList.map((e) => activeCtx(e)).filter(Boolean);
    if (!ctxs.length) return warn('nothing installed');

    const before = info.ids;
    const result = off
      ? (flags.all ? autostart.disableAll() : autostart.disable(ctxs))
      : (flags.all ? autostart.enableAll(ctxs) : autostart.enable(ctxs));

    if (flags.json) return jsonOut(result);
    const shown = off ? before : result.ids;
    ok(`${off ? 'disabled' : 'enabled'} autostart: ${shown.length ? shown.join(', ') : '(none)'}`);
    hint(`${result.manager} · ${result.file}`);
    for (const w of result.warnings) warn(w);
    return;
  }

  const rows = engineList
    .map((e) => {
      const ctx = activeCtx(e);
      if (!ctx) return null;
      const id = `${ctx.key}:${ctx.major}`;
      return [e.label, `${ctx.key}@${ctx.major}`, info.ids.includes(id) ? 'on' : 'off'];
    })
    .filter(Boolean);

  if (flags.json) return jsonOut(info);
  out(table(['DATABASE', 'REF', 'AUTOSTART'], rows));
  hint(`${info.manager} · ${info.file}${info.installed ? '' : ' (not installed yet)'}`);
}

async function cmdStatus(flags, args) {
  if (args.length > 1) {
    const rows = [];
    for (const ref of args) {
      const { engine, ctx } = resolveRef(ref);
      const versions = installedVersions(engine);
      const activeVersion = state.getActive(engine.key);
      const activePick = versions.find((v) => v.version === activeVersion) || versions[versions.length - 1];
      const st = await versionStatus(engine, versions.find((v) => v.version === ctx.version), activePick);
      rows.push({ ...st, label: engine.label, auth: ctx.engine.account?.(ctx) || null });
    }
    if (flags.json) return jsonOut(rows);
    out(renderServices(rows));
    return;
  }
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
    return jsonOut(rows.map(({ ctx, engine, ...r }) => ({ ...r, auth: engine.account?.(ctx) || null })));
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
  const { engine, ctx } = resolveRef(ref);
  if (args[1] !== undefined || flags.port !== undefined) {
    const result = await changePort(ctx, args[1] ?? flags.port);
    if (flags.json) return jsonOut(result);
    if (result.same) return info(`port ${ctx.key}@${ctx.major} already ${result.port}`);
    ok(`port ${ctx.key}@${ctx.major} -> ${result.port}${result.restarted ? ' (restarted)' : ''}`);
    if (!result.restarted) hint(`start with: marina start ${ctx.key}@${ctx.major}`);
    return;
  }
  out(String(state.portOf(engine.key, ctx.major, engine.defaultPort)));
}

async function cmdAuth(flags, args) {
  const ref = requireRef(args, flags);
  const { ctx } = resolveRef(ref);
  const patch = {};
  if (args[1] !== undefined || flags.user !== undefined) patch.user = args[1] ?? flags.user;
  if (args[2] !== undefined || flags.password !== undefined) patch.password = args[2] ?? flags.password;

  if (Object.keys(patch).length) {
    const result = await changeAccount(ctx, patch);
    if (result.error) {
      if (!flags.json) throw new Error(result.error);
      process.exitCode = 1;
    }
    if (flags.json) return jsonOut(result);
    const a = result.account;
    ok(`saved ${ctx.key} account ${a.user || '—'}${a.password ? ` / ${a.password}` : '  (no password)'}`);
    for (const n of result.notes) warn(n);
    return;
  }

  const a = ctx.engine.account?.(ctx) || { ...ctx.account, mode: 'unknown' };
  if (flags.json) return jsonOut({ key: ctx.key, ...a });
  out(table(['DATABASE', 'ACCOUNT', 'PASSWORD', 'MODE'], [[
    `${ctx.key}@${ctx.major}`, a.user || '—', a.password || '—', a.mode || '—',
  ]]));
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
  if (!binName && engine.endpoint) throw new Error(`Connect to ${engine.label} at ${engine.endpoint(ctx)}`);
  const bin = findBin(ctx.root, [binName]);
  if (!bin) {
    throw new Error(`${engine.label} ${ctx.version} has no "${binName}" client binary\n  hint: try --bin ${(engine.clientBins || []).join(' | ')}`);
  }
  const isServer = (engine.serverBin || []).includes(binName);
  const prefix = !isServer && engine.clientArgs ? engine.clientArgs(ctx) : [];
  const child = spawn(bin, [...prefix, ...pass], { stdio: 'inherit', env: clientEnv() });
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
  const child = spawn(found.path, [...prefix, ...pass], { stdio: 'inherit', env: clientEnv() });
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
  const wasQuiet = isQuiet();
  if (flags.json) setQuiet(true);
  try {
    return await dispatch(flags, rest, tail);
  } finally {
    setQuiet(wasQuiet);
  }
}

async function dispatch(flags, rest, tail) {
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
    case 'autostart':
    case 'boot': return cmdAutostart(flags, args);
    case 'auth': return cmdAuth(flags, args);
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
      process.exitCode = 1;
      fail(`unknown command "${command}"`);
      out('');
      return out(HELP);
  }
}
