// Shared driver for the MySQL protocol family (MySQL + MariaDB).
//
// Lifecycle mirrors what a packaged dev environment needs:
//   install -> extract -> render my.cnf -> <init datadir> -> start -> set root
//   password + drop anonymous users/test db -> stop
import path from 'node:path';
import fs from 'node:fs';
import { spawnAsync } from '../install/archive.js';
import { mkdirp } from '../core/paths.js';
import { findBin } from '../install/archive.js';
import { host } from '../host/index.js';

async function runUnixInstaller(ctx, installer, options) {
  const init = (cmd, root, dataDir) => spawnAsync(cmd, [
    '--no-defaults',
    `--basedir=${root}`,
    `--datadir=${dataDir}`,
    ...options,
  ], { cwd: root });
  if (![ctx.root, ctx.dataDir].some((dir) => /[\s*?\[\]]/.test(dir))) {
    return init(installer, ctx.root, ctx.dataDir);
  }

  // mariadb-install-db splits the search path when it looks for my_print_defaults.
  const staging = fs.mkdtempSync('/tmp/marina-mariadb-init-');
  try {
    const root = path.join(staging, 'install');
    const dataDir = path.join(staging, 'data');
    fs.symlinkSync(ctx.root, root);
    fs.symlinkSync(ctx.dataDir, dataDir);
    return await init(path.join(root, path.relative(ctx.root, installer)), root, dataDir);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

function initializeMariaDb(ctx, installer) {
  if (host.id === 'win32') return spawnAsync(installer, [`--datadir=${ctx.dataDir}`]);
  return runUnixInstaller(ctx, installer, ['--auth-root-authentication-method=normal', '--skip-test-db']);
}

function isMysql56(ctx) {
  return ctx.key === 'mysql' && ctx.major === '5.6';
}

async function initializeMysql56(ctx) {
  // A failed mysql_install_db can create mysql/ before it has written the grant tables.
  const dataDir = fs.mkdtempSync(path.join(path.dirname(ctx.dataDir), '.mysql-init-'));
  try {
    if (host.id === 'win32') {
      const seed = path.join(ctx.root, 'data');
      if (!fs.existsSync(path.join(seed, 'mysql', 'user.frm'))) throw new Error('MySQL 5.6 package is missing its initial grant tables');
      const mysqld = findBin(ctx.root, ['mysqld']);
      if (!mysqld) throw new Error('cannot find mysqld for MySQL 5.6');
      const probe = await spawnAsync(mysqld, ['--no-defaults', '--version'], { cwd: ctx.root, windowsHide: true });
      if ((probe.code >>> 0) === 0xC0000135) {
        throw new Error('MySQL 5.6 on Windows requires Microsoft Visual C++ 2010 SP1 Redistributable (x64). Download it at https://www.microsoft.com/en-us/download/details.aspx?id=26999');
      }
      if (probe.code !== 0) throw new Error(probe.stderr.trim() || `mysqld --version exited with ${probe.code}`);
      fs.cpSync(seed, dataDir, { recursive: true });
    } else {
      const installer = findBin(ctx.root, ['mysql_install_db']);
      if (!installer) throw new Error('cannot find mysql_install_db for MySQL 5.6');
      const res = await runUnixInstaller({ ...ctx, dataDir }, installer, ['--force', '--keep-my-cnf']);
      if (res.code !== 0) throw new Error(`mysql_install_db failed:\n${res.stderr.trim() || res.stdout.trim()}`);
    }
    if (!fs.existsSync(path.join(dataDir, 'mysql', 'user.frm'))) throw new Error('MySQL 5.6 did not create the initial grant tables');
    fs.rmdirSync(ctx.dataDir);
    fs.renameSync(dataDir, ctx.dataDir);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

export function mysqlAccountSql(ctx, user, password, grant = false) {
  const literal = (value) => `'${String(value ?? '').replace(/'/g, "''")}'`;
  const account = `${literal(user)}@'localhost'`;
  const pw = literal(password);
  const privileges = `GRANT ALL PRIVILEGES ON *.* TO ${account}`;
  if (isMysql56(ctx)) {
    return [grant ? `${privileges} IDENTIFIED BY ${pw} WITH GRANT OPTION;`
      : `SET PASSWORD FOR ${account} = PASSWORD(${pw});`];
  }
  return grant
    ? [`CREATE USER IF NOT EXISTS ${account} IDENTIFIED BY ${pw};`, `${privileges} WITH GRANT OPTION;`]
    : [`ALTER USER ${account} IDENTIFIED BY ${pw};`];
}

function transportArgs(ctx) {
  if (host.capabilities.unixSocket) return [`--socket=${ctx.sockFile}`];
  return ['--protocol=TCP', '-h', '127.0.0.1', '-P', String(ctx.port)];
}

export function makeMysqlFamily(opts) {
  const {
    key,
    label,
    manifestName,
    defaultMajor,
    defaultPort,
    initKind, // 'mysql-initialize' | 'mariadb-install-db'
    serverNames,
    clientNames,
    // shutdown/ping helper, most preferred first. MariaDB ships mysqladmin as a
    // deprecated alias that prints a notice on every invocation, so it must not
    // win when the non-deprecated name exists.
    adminNames = ['mysqladmin', 'mariadb-admin'],
    supportsXPlugin,
  } = opts;

  return {
    key,
    label,
    kind: 'sql',
    manifestName,
    defaultMajor,
    defaultPort,
    markers: [...serverNames.flatMap((n) => [`bin/${n}`, `sbin/${n}`]), 'bin/mysql', 'bin/mariadb'],
    serverBin: serverNames,
    clientBins: clientNames,
    primaryClient: clientNames[0],

    clientArgs(ctx) {
      const args = [];
      if (host.capabilities.unixSocket) args.push(`--socket=${ctx.sockFile}`);
      else args.push('--protocol=TCP', '-h', '127.0.0.1', '-P', String(ctx.port));
      const acct = ctx.account || { user: 'root', password: ctx.password };
      if (acct.user) args.push(`-u${acct.user}`);
      if (acct.password) args.push(`-p${acct.password}`);
      return args;
    },

    bin(ctx, names = serverNames) {
      return findBin(ctx.root, names);
    },

    readPid(ctx) {
      try {
        const raw = fs.readFileSync(ctx.pidFile, 'utf8').trim();
        const pid = parseInt(raw.split(/\s+/)[0], 10);
        return Number.isFinite(pid) ? pid : null;
      } catch {
        return null;
      }
    },

    renderConfig(ctx) {
      const xplugin = supportsXPlugin && /^(8|9)\./.test(ctx.major) ? 'mysqlx                      = 0\n' : '';
      return `# generated by marina — edit, then: marina restart ${key}
[client]
[mysqld]
bind-address = 127.0.0.1
${xplugin}
skip-external-locking
max_allowed_packet      = 64M
max_connections         = 200
table_open_cache        = 2000
sort_buffer_size        = 4M
read_buffer_size        = 1M
tmp_table_size          = 64M
default_storage_engine  = InnoDB
innodb_file_per_table   = 1
innodb_buffer_pool_size = 256M
innodb_flush_log_at_trx_commit = 1
character-set-server    = utf8mb4
explicit_defaults_for_timestamp = true

[mysqldump]
quick
max_allowed_packet = 64M

[mysql]
no-auto-rehash
`;
    },

    async init(ctx) {
      if (fs.existsSync(path.join(ctx.dataDir, 'mysql'))) return { skipped: true };
      mkdirp(ctx.dataDir);
      mkdirp(ctx.logDir);
      if (isMysql56(ctx)) {
        await initializeMysql56(ctx);
      } else if (initKind === 'mysql-initialize') {
        const mysqld = findBin(ctx.root, serverNames);
        if (!mysqld) throw new Error(`cannot find ${serverNames[0]} under ${ctx.root}`);
        const res = await spawnAsync(mysqld, [
          '--no-defaults',
          '--initialize-insecure',
          `--basedir=${ctx.root}`,
          `--datadir=${ctx.dataDir}`,
          `--tmpdir=${ctx.tmpDir}`,
        ]);
        if (res.code !== 0) throw new Error(`${serverNames[0]} --initialize-insecure failed:\n${res.stderr.trim()}`);
      } else {
        const installer = findBin(ctx.root, ['mariadb-install-db', 'mysql_install_db']);
        if (!installer) throw new Error('cannot find mariadb-install-db / mysql_install_db');
        const res = await initializeMariaDb(ctx, installer);
        if (res.code !== 0) throw new Error(`${path.basename(installer)} failed:\n${res.stderr.trim() || res.stdout.trim()}`);
      }
      return { created: true };
    },

    startArgs(ctx) {
      const args = [
        `--defaults-file=${ctx.confFile}`,
        `--basedir=${ctx.root}`,
        `--datadir=${ctx.dataDir}`,
        `--tmpdir=${ctx.tmpDir}`,
        `--pid-file=${ctx.pidFile}`,
        `--log-error=${ctx.logFile}`,
        `--port=${ctx.port}`,
        '--bind-address=127.0.0.1',
      ];
      if (host.capabilities.unixSocket || host.id === 'openharmony') args.push(`--socket=${ctx.sockFile}`);
      return args;
    },

    stopCommand(ctx) {
      const admin = findBin(ctx.root, adminNames);
      if (!admin) return null;
      const target = transportArgs(ctx);
      const acct = ctx.account || { user: 'root', password: ctx.password };
      return {
        cmd: admin,
        args: [...target, `-u${acct.user || 'root'}`, ...(acct.password ? [`-p${acct.password}`] : []), '--connect-timeout=2', 'shutdown'],
      };
    },

    async postInit(ctx) {
      const client = findBin(ctx.root, ['mysql', 'mariadb']);
      if (!client) throw new Error('mysql client not found for first-run bootstrap');
      const acct = ctx.account || { user: 'root', password: ctx.password };
      const user = acct.user || 'root';
      const sql = [
        "SET SESSION sql_mode = 'NO_BACKSLASH_ESCAPES';",
        ...mysqlAccountSql(ctx, 'root', acct.password),
        ...(user === 'root' ? [] : mysqlAccountSql(ctx, user, acct.password, true)),
        `DELETE FROM mysql.user WHERE User='';`,
        isMysql56(ctx) ? "DELETE FROM mysql.user WHERE User='root' AND Host <> 'localhost';"
          : "DELETE FROM mysql.user WHERE User='root' AND Host NOT IN ('localhost','127.0.0.1','::1');",
        `DROP DATABASE IF EXISTS test;`,
        `FLUSH PRIVILEGES;`,
      ].join('\n');
      const target = transportArgs(ctx);
      const args = [...target, '-uroot'];
      let res = await spawnAsync(client, args, { input: sql });
      // An earlier attempt may have set root's password before losing its connection.
      if (res.code !== 0 && acct.password) res = await spawnAsync(client, [...args, `-p${acct.password}`], { input: sql });
      if (res.code !== 0) throw new Error(`root password setup failed: ${res.stderr.trim()}`);
    },

    account(ctx) {
      const acct = ctx.account || { user: 'root', password: ctx.password };
      return {
        user: acct.user || 'root',
        password: acct.password ?? '',
        mode: 'password',
        note: `${acct.user || 'root'}@localhost, password set on first install`,
      };
    },

    async probe(ctx) {
      // socket ping via client is the strongest signal, TCP is the fallback
      const admin = findBin(ctx.root, adminNames);
      if (admin && (!host.capabilities.unixSocket || fs.existsSync(ctx.sockFile))) {
        const target = transportArgs(ctx);
        const acct = ctx.account || { user: 'root', password: ctx.password };
        const res = await spawnAsync(admin, [...target, `-u${acct.user || 'root'}`, ...(acct.password ? [`-p${acct.password}`] : []), '--connect-timeout=2', 'ping']);
        if (res.code === 0) return true;
      }
      return null; // let the generic TCP probe decide
    },

    pidNote: 'pid-file is written by the server, as configured in my.cnf',
  };
}
