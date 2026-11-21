// Environment isolation for everything marina spawns.
//
// A person's shell is full of other tools' state: extra PATH entries, pkg-config
// and compiler flags, PG*/MYSQL_* connection defaults. Left inherited, that state
// leaks into source builds (foreign headers/libs get baked into a payload) and
// redirects marina's clients to some other server. These helpers cut both paths.
import { IS_WIN } from './platform.js';

// Variables that choose *which server* or *which credentials* a client uses.
// marina always passes host/port/socket/user explicitly, so none may leak in.
const CONNECTION_VARS = [
  'PGHOST', 'PGHOSTADDR', 'PGPORT', 'PGUSER', 'PGPASSWORD', 'PGPASSFILE', 'PGDATABASE',
  'PGSERVICE', 'PGSERVICEFILE', 'PGSYSCONFDIR', 'PGOPTIONS', 'PGDATA',
  'PGSSLMODE', 'PGSSLCERT', 'PGSSLKEY', 'PGSSLROOTCERT', 'PGCONNECT_TIMEOUT',
  'MYSQL_HOST', 'MYSQL_TCP_PORT', 'MYSQL_UNIX_PORT', 'MYSQL_PWD', 'MYSQL_HOME', 'MYSQL_GROUP_SUFFIX',
  'MYSQLX_TCP_PORT', 'MYSQLX_UNIX_PORT',
  'REDISCLI_AUTH',
];

// Variables that make a compiler or linker pick up headers/libraries from outside
// the system toolchain, which would tie a payload to this machine.
const BUILD_VARS = [
  'PKG_CONFIG', 'PKG_CONFIG_PATH', 'PKG_CONFIG_LIBDIR', 'PKG_CONFIG_SYSROOT_DIR',
  'CPPFLAGS', 'CFLAGS', 'CXXFLAGS', 'LDFLAGS', 'LIBS',
  'CPATH', 'C_INCLUDE_PATH', 'CPLUS_INCLUDE_PATH', 'LIBRARY_PATH',
  'CMAKE_PREFIX_PATH', 'CMAKE_INCLUDE_PATH', 'CMAKE_LIBRARY_PATH', 'ACLOCAL_PATH',
  'CC', 'CXX', 'AR', 'AS', 'LD', 'NM', 'RANLIB', 'MAKEFLAGS', 'MFLAGS', 'MAKEOVERRIDES', 'CONFIG_SITE',
];

const LOADER_VARS = [
  'LD_LIBRARY_PATH', 'LD_PRELOAD', 'LD_AUDIT', 'DYLD_LIBRARY_PATH', 'DYLD_FALLBACK_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES',
];

export const SYSTEM_PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'];

function without(base, names) {
  const out = { ...base };
  for (const name of names) delete out[name];
  return out;
}

/** Environment for running a client or helper against a marina-managed server. */
export function clientEnv(base = process.env) {
  return without(base, [...CONNECTION_VARS, ...LOADER_VARS]);
}

/**
 * Environment for compiling an engine from source: only the system toolchain on
 * PATH, no compiler/linker search-path overrides. Extra tool directories (for
 * example a cmake that is not installed system-wide) are opt-in through
 * MARINA_BUILD_PATH.
 */
export function buildEnv(base = process.env) {
  const env = without(base, [...CONNECTION_VARS, ...BUILD_VARS, ...LOADER_VARS]);
  if (IS_WIN) return env;
  const extra = String(base.MARINA_BUILD_PATH || '').split(':').filter(Boolean);
  env.PATH = [...extra, ...SYSTEM_PATH].join(':');
  return env;
}
