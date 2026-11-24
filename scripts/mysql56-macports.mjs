import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const libraries = {
  libedit: ['libedit.0.dylib'],
  libevent: ['libevent_core-2.1.7.dylib', 'libevent_extra-2.1.7.dylib'],
  tcp_wrappers: ['libwrap.7.dylib'],
  zlib: ['libz.1.dylib'],
  ncurses: ['libncurses.6.dylib'],
};

export function stageMacPortsMysql56(extracted, inputs, work) {
  const prefix = path.join(extracted, 'opt/local');
  const root = path.join(work, 'mysql56');
  const share = path.join(root, 'share');
  const messages = path.join(share, 'mysql56');
  const docs = path.join(root, 'docs');
  const lib = path.join(root, 'lib');
  fs.mkdirSync(path.join(root, 'etc/mysql56'), { recursive: true });
  for (const [source, destination] of [
    ['lib/mysql56/bin', 'bin'], ['lib/mysql56/plugin', 'lib/plugin'], ['lib/mysql56/mysql', 'lib/mysql'],
    ['share/mysql56', 'share/mysql56'], ['share/doc/mysql56', 'docs'],
  ]) {
    fs.cpSync(path.join(prefix, source), path.join(root, destination), { recursive: true, verbatimSymlinks: true });
  }
  fs.copyFileSync(path.join(extracted, '+PORTFILE'), path.join(docs, 'mysql56.Portfile'));
  // mysqld uses the MacPorts message path, while mysql_install_db looks in share/.
  for (const name of fs.readdirSync(messages)) fs.symlinkSync('mysql56/' + name, path.join(share, name));
  fs.symlinkSync('english/errmsg.sys', path.join(messages, 'errmsg.sys'));
  fs.symlinkSync('mysql56/support-files/my-default.cnf', path.join(share, 'my-default.cnf'));

  const clientLibrary = 'libmysqlclient.18.dylib';
  const installNames = new Map([['/opt/local/lib/mysql56/mysql/' + clientLibrary, path.join(lib, 'mysql', clientLibrary)]]);
  for (const [port, names] of Object.entries(libraries)) {
    const binary = inputs.find(({ url }) => url.startsWith('https://packages.macports.org/' + port + '/'));
    if (!binary) throw new Error('missing locked MacPorts runtime for ' + port);
    const runtime = path.join(work, port);
    fs.mkdirSync(runtime);
    execFileSync('tar', ['-xf', binary.file, '-C', runtime]);
    fs.copyFileSync(path.join(runtime, '+PORTFILE'), path.join(docs, port + '.Portfile'));
    for (const name of names) {
      const destination = path.join(lib, name);
      fs.copyFileSync(path.join(runtime, 'opt/local/lib', name), destination);
      installNames.set('/opt/local/lib/' + name, destination);
    }
    const source = inputs.find(({ url }) => url.startsWith('https://distfiles.macports.org/' + port + '/'));
    if (source) {
      const folder = path.basename(source.file, '.tar.gz');
      const license = port === 'libevent' ? 'LICENSE' : 'COPYING';
      fs.writeFileSync(path.join(docs, 'LICENSE-' + port), execFileSync('tar', ['-xOf', source.file, folder + '/' + license]));
    } else if (port === 'tcp_wrappers' || port === 'zlib') {
      const notice = port === 'tcp_wrappers' ? 'DISCLAIMER' : 'README';
      fs.copyFileSync(path.join(runtime, 'opt/local/share/doc', port, notice), path.join(docs, 'LICENSE-' + port));
    } else {
      throw new Error('missing locked sources for the ' + port + ' license');
    }
  }
  return { root, installNames };
}
