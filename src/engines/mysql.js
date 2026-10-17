import { makeMysqlFamily } from './_mysql_family.js';

export default makeMysqlFamily({
  key: 'mysql',
  label: 'MySQL',
  manifestName: 'mysql',
  defaultMajor: '8.4',
  defaultPort: 3306,
  initKind: 'mysql-initialize',
  serverNames: ['mysqld'],
  clientNames: ['mysql', 'mysqldump', 'mysqladmin', 'mysqlimport', 'mysqlpump', 'mysqld_safe'],
  supportsXPlugin: true,
});
