import { makeMysqlFamily } from './_mysql_family.js';

export default makeMysqlFamily({
  key: 'mariadb',
  label: 'MariaDB',
  manifestName: 'mariadb',
  defaultMajor: '11.4',
  defaultPort: 3307,
  initKind: 'mariadb-install-db',
  adminNames: ['mariadb-admin', 'mysqladmin'],
  serverNames: ['mariadbd', 'mysqld'],
  clientNames: ['mariadb', 'mysql', 'mariadb-dump', 'mysqldump', 'mariadb-admin', 'mysqladmin'],
  supportsXPlugin: false,
});
