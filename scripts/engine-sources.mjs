// Upstream archives are locked here. Updating a matrix version also requires
// choosing and verifying the source inputs for each affected target.
const input = (url, sha256) => ({ url, sha256 });
const mysql = (file, sha) => input('https://cdn.mysql.com/Downloads/MySQL-8.4/mysql-8.4.11-' + file, sha);
const maria = (file, sha) => input('https://archive.mariadb.org/mariadb-11.4.13/' + file, sha);
const mongo = (file, sha) => input('https://fastdl.mongodb.org/' + file, sha);
const mongosh = (file, sha) => input('https://github.com/mongodb-js/mongosh/releases/download/v2.14.2/mongosh-2.14.2-' + file, sha);

const mysqlBinaries = {
  'darwin-x64': mysql('macos15-x86_64.tar.gz', '90e8aea10698d01b978f0179e72e8d5e2cbe9f9bd5771e88b0b75d7c82244d3f'),
  'darwin-arm64': mysql('macos15-arm64.tar.gz', 'b96e00493bc3499b9ffd7f08d65c5d64933af0383a8287d9873b64f94c2d6009'),
  'linux-x64': mysql('linux-glibc2.28-x86_64-minimal.tar.xz', '383f54e124d5f325d67f0c6912a8f96814eedc761a17ea30112e52fa4cc6b143'),
  'linux-arm64': mysql('linux-glibc2.28-aarch64.tar.xz', '04b2f9791d314167a9eb83abcb476f45a7cd9e4aa88fa7a638cba40d1bc2a109'),
  'win32-x64': mysql('winx64.zip', 'a492371d687d2bab088b0062581144a0044b8964baefdf4faa579292b423d25c'),
};

const mongoBinaries = {
  'darwin-x64': mongo('osx/mongodb-macos-x86_64-7.0.45.tgz', 'f9fb2104e7eb525b48b61f7e5ab8af2b2172b031fded1a7f2c5be1b487a20b1a'),
  'darwin-arm64': mongo('osx/mongodb-macos-arm64-7.0.45.tgz', '23fa267630e47fb8b95935a4bbb6fed5f43f313735b6e17fe55cacce98403deb'),
  'linux-x64': mongo('linux/mongodb-linux-x86_64-ubuntu2204-7.0.45.tgz', 'c2eec1e4aaee967838430ac57fc7d46c22f566c718eda6033e32add80d506f8b'),
  'linux-arm64': mongo('linux/mongodb-linux-aarch64-ubuntu2204-7.0.45.tgz', 'dfdfb314e2f6fc48fe01588d39d2b44b168fa589b5df12d354a0dbd68e71f95a'),
  'win32-x64': mongo('windows/mongodb-windows-x86_64-7.0.45.zip', '7e3a435fa86e36e8ca4f2618fb41de06d75c28009c63725a20f9badd36eec6f6'),
};

const mongoShell = {
  'darwin-x64': mongosh('darwin-x64.zip', 'ecd6b768a3994d21e95b27c55470fb4df7f5b6dd13bf3890aea42ea981df4c0c'),
  'darwin-arm64': mongosh('darwin-arm64.zip', '6ac2f30b1ec107c5653baeb2f2869457b1e4e117aef4ffd303e2bc11b5184092'),
  'linux-x64': mongosh('linux-x64.tgz', '1523e16da7c6902333b681bf65d83bbef59bff558c46ac5636371d13beb4de53'),
  'linux-arm64': mongosh('linux-arm64.tgz', '20f89386f74c14cb63a163eea5491dc14759bcd64229b1c099c2390585a01fd3'),
  'win32-x64': mongosh('win32-x64.zip', '93072fa3466fdd309c3e40ec0b1e8b805a90ef7e455868320117b3d2c756a4bc'),
};

const binaries = {
  'mysql@8.4.11': mysqlBinaries,
  'mariadb@11.4.13': {
    'linux-x64': maria('bintar-linux-systemd-x86_64/mariadb-11.4.13-linux-systemd-x86_64.tar.gz', '3cebf63914df3154b7cb6d548337eb2be42c773aeb641110446b72e2746cfed7'),
    'win32-x64': maria('winx64-packages/mariadb-11.4.13-winx64.zip', 'd62986d433eeebfde218560b276103831604a61e929e87f1a17f5aebd80257e2'),
  },
  'postgres@17.11': {
    'win32-x64': input('https://get.enterprisedb.com/postgresql/postgresql-17.11-1-windows-x64-binaries.zip', '6eabdf00d2893713b75db4336a23c3fdf505f056e217ec6e2e95d901750cfea3'),
  },
  'mongodb@7.0.45': mongoBinaries,
  'redis@7.4.11': {
    'win32-x64': input('https://github.com/redis-windows/redis-windows/releases/download/7.4.11/Redis-7.4.11-Windows-x64-cygwin.zip', '835999942bbef27e2b01f4a36955522cf19fff6511e67bbfe3fee322f6586705'),
  },
  'memcached@1.6.8': {
    'win32-x64': input('https://github.com/jefyt/memcached-windows/releases/download/1.6.8_mingw_libressl/memcached-1.6.8-win64-mingw.zip', '48ec62cef718f0d73698414b783c0e4a69821013553ca00afe0eed324eb5994b'),
  },
};

const sourceArchives = {
  'mariadb@11.4.13': maria('source/mariadb-11.4.13.tar.gz', '1bb254b106d0a7ca871cfa18fa6e18d4b80a7430f9ec9d1571ec4271a13def96'),
  'postgres@17.11': input('https://ftp.postgresql.org/pub/source/v17.11/postgresql-17.11.tar.gz', '5367f6fb2ec97efe1eb2e0c7926bb33438e51b0bd3a9733b88498056a7dc9a7e'),
  'redis@7.4.11': input('https://download.redis.io/releases/redis-7.4.11.tar.gz', '3c266ece0abd54ed3b1c912c6eb86b7508cf382cb690ee6649d3843f018f6357'),
  'memcached@1.6.45': input('https://memcached.org/files/memcached-1.6.45.tar.gz', 'd362c64e6d8d5287153501eabf7c85b4a761432fbf53f5d7b085d0bb1653c1dd'),
};

const libevent = input(
  'https://github.com/libevent/libevent/releases/download/release-2.1.12-stable/libevent-2.1.12-stable.tar.gz',
  '92e6de1be9ec176428fd2367677e61ceffc2ee1cb119035037a27d346b0403bb',
);

const sourceCode = {
  'mysql@8.4.11': ['https://cdn.mysql.com/Downloads/MySQL-8.4/mysql-8.4.11.tar.gz'],
  'mongodb@7.0.45': [
    'https://github.com/mongodb/mongo/tree/r7.0.45',
    'https://github.com/mongodb-js/mongosh/tree/v2.14.2',
  ],
  'memcached@1.6.8': ['https://github.com/jefyt/memcached-windows/tree/1.6.8_mingw_libressl'],
};

export function sourcesFor({ engine, version, os, arch, inputs }) {
  if (inputs) return validateInputs(inputs, os);
  const id = engine + '@' + version;
  const target = os + '-' + arch;
  const binary = binaries[id]?.[target];
  const source = binary ? null : sourceArchives[id];
  if (!binary && (!source || os === 'win32')) throw new Error('no build inputs for ' + id + ' on ' + target);
  const additional = engine === 'mongodb' ? [mongoShell[target]] : engine === 'memcached' && source ? [libevent] : [];
  const upstream = sourceCode[id] ?? [sourceArchives[id]?.url].filter(Boolean);
  const windowsRedis = os === 'win32' && engine === 'redis'
    ? ['https://github.com/redis-windows/redis-windows/tree/7.4.11', 'https://cygwin.com/licensing.html'] : [];
  return { binary, source, additional, sourceCode: [...upstream, ...windowsRedis] };
}

function validateInputs({ binary, source, additional = [], sourceCode = [] }, os) {
  if (Boolean(binary) === Boolean(source) || (source && os === 'win32') ||
      !Array.isArray(additional) || !Array.isArray(sourceCode)) {
    throw new Error('invalid custom build inputs');
  }
  for (const { url, sha256, size } of [binary ?? source, ...additional]) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password ||
        !/^[a-f0-9]{64}$/.test(sha256 ?? '') || (size != null && (!Number.isSafeInteger(size) || size <= 0))) {
      throw new Error('custom build inputs require an HTTPS URL and SHA-256');
    }
  }
  return { binary, source, additional, sourceCode };
}
