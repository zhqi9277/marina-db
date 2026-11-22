<p align="center">
  <img src="./assets/logo.png" alt="Marina logo" width="96">
</p>

<h1 align="center">Marina</h1>

<p align="center">Install, switch, and run local databases from one CLI.</p>

<p align="center">
  <strong>English</strong> · <a href="./README.zh-CN.md" lang="zh-CN">简体中文</a>
</p>

Marina manages MySQL, MariaDB, PostgreSQL, MongoDB, Redis, and Memcached for local development. It installs prebuilt database packages, keeps multiple versions side by side, and gives you a keyboard-driven terminal dashboard for everyday operations.

[Quick start](#quick-start) · [Supported platforms](#supported-platforms) · [Command reference](#command-reference) · [Development](#development)

## Quick start

You'll need Git, Node.js **18.17 or newer**, and `tar` on your PATH. Run these commands from a terminal to install Redis 7, start it, and check the connection.

```sh
git clone https://github.com/zhqi9277/marina-db.git
cd marina-db

node bin/marina.js remote redis
node bin/marina.js install redis@7
node bin/marina.js start redis@7
node bin/marina.js exec redis@7 -- ping
# PONG
```

Marina verifies the downloaded package and prepares the instance during installation. Use `start` to run the service and `stop` when you're done.

### Add `marina` to your PATH

Run `npm link` from the checkout to use `marina` as a command. On macOS and Linux, you can also install the launcher into `~/.local/bin`.

```sh
sh scripts/install-cli.sh
export PATH="$HOME/.local/bin:$PATH"
marina --version
```

Use `node bin/marina.js` from the checkout for any example that starts with `marina`.

## Terminal dashboard

Run `marina` in an interactive terminal. Select a database to see its active version, running state, port, and connection details.

| Key | Action |
| --- | --- |
| `↑` / `↓` | Select a database or version |
| `Enter` | Open actions or select a version |
| `v` | Fetch available versions and open the version picker |
| `g` | Fetch the latest catalog while the version picker is open |
| `s` / `x` / `r` | Start, stop, or restart the selected instance |
| `l` / `d` | Open logs or diagnostics |
| `?` / `q` | Show keyboard help or quit from the dashboard |

## Supported platforms

| Platform | Architectures | Build and test environment |
| --- | --- | --- |
| macOS | Apple Silicon (ARM64), Intel (x64) | macOS 15 |
| Linux | x64, ARM64 | Ubuntu 22.04 |
| Windows | x64 | Windows Server 2022 |

| Engine | CLI name | Default port |
| --- | --- | --- |
| MySQL | `mysql` | 3306 |
| MariaDB | `mariadb` | 3307 |
| PostgreSQL | `postgres` | 5432 |
| MongoDB | `mongodb` | 27017 |
| Redis | `redis` | 6379 |
| Memcached | `memcached` | 11211 |
| Qdrant | `qdrant` | 6333 |

Version availability depends on your operating system and architecture. `marina remote` fetches the current published catalog and shows the builds available on your machine. [Published catalog](https://github.com/zhqi9277/marina-db/blob/engine-catalog/manifest.json) · [Engine packages](https://github.com/zhqi9277/marina-db/releases)

Set `MARINA_CATALOG_URL` to use another remote catalog or `MARINA_CATALOG_FILE` to read a local manifest.

## Command reference

| Command | Use it to |
| --- | --- |
| `marina remote mysql` | List published MySQL versions for your machine |
| `marina install mysql@8.4` | Install the latest published patch in the 8.4 series |
| `marina install mysql@8.4.11` | Install a specific release |
| `marina use mysql@8.4.11` | Select an installed version |
| `marina start mysql@8.4` | Start the selected version in that series |
| `marina status mysql@8.4` | Check the running version, port, and process |
| `marina logs mysql --lines 50` | Read the last 50 log lines |
| `marina exec mysql@8.4 -- -e "SELECT VERSION()"` | Run the matching client with the instance's connection settings |
| `marina port mysql 3308` | Set the instance's port |
| `marina auth mysql` | Show the instance's connection account |
| `marina autostart redis` | Start Redis at user login |
| `marina stop mysql@8.4` | Stop the running instance |
| `marina ls` | List installed versions |
| `marina doctor` | Check the local environment, binary libraries, and port conflicts |

### Pin versions for a project

Install the versions your project needs and add a `.marinarc` JSON file to its root.

```json
{
  "mysql": "8.4.11",
  "redis": "7.4.11"
}
```

Run `marina use` inside the project to apply the nearest `.marinarc`. Run `marina current` to see the active versions and project pins.

### Install from a local archive

Use a compatible engine package that you already have on disk.

```sh
marina install redis@7.4.11 --file ./redis-7.4.11-linux-x64.tar.gz
```

## Local data

Marina uses `runtime/` when the checkout is writable. It falls back to `~/.marina` in a read-only installation. Set `MARINA_HOME` to choose another runtime directory.

| Path under the runtime directory | Contents |
| --- | --- |
| `engines/<db>/<series>/<version>/` | Extracted binaries for each installed release |
| `data/<db>/<series>/` | Database files for the version series |
| `etc/<db>/<series>/` | Instance configuration |
| `logs/<db>/<series>.log` | Server logs |
| `state.json` | Version selections, ports, and local credentials |

Patch releases in the same series share a data directory. For example, MySQL 8.4 patches share `data/mysql/8.4/`. Removing a version with `marina rm` keeps its data. Use `--purge` only when you intend to delete the data for the series.

Services bind to loopback by default. Marina stores local credentials in plain text in `state.json`. Use development credentials for these instances.

## Troubleshooting

| If you see | Check |
| --- | --- |
| A version is missing | Run `marina remote <db>` to check the current catalog for your platform |
| The catalog is unavailable | Check access to GitHub and retry the command, or install an existing archive with `--file` |
| A port is already in use | Run `marina doctor` and choose a free port with `marina port <db> <port>` |
| A service fails to start | Check `marina logs <db>` for the server error and run `marina doctor` |

## Development

The CLI uses Node.js built-in modules. Run the test suite from the repository root.

```sh
npm test
```

Run `build-engines` with one database and a comma-separated list of versions. GitHub Actions builds and smoke-tests each version and platform, then keeps the packages as workflow artifacts for seven days. Run `promote-engines` with the successful run ID to add the packages to the database's shared Release, such as `engines-redis`, and update the installation catalog. Use `migrate_engine` to copy that database's already published archives into the shared Release and update their catalog links without rebuilding. [Build workflow](./.github/workflows/build-engines.yml) · [Promotion workflow](./.github/workflows/promote-engines.yml)

The build workflow checks upstream releases for each database daily on `main`. It discovers new versions and release series and skips packages already published or covered by unexpired build artifacts. To check immediately, select an engine and enable `incremental` in `build-engines`. Use the successful run ID to promote the builds when ready.

Report bugs and feature requests in [GitHub Issues](https://github.com/zhqi9277/marina-db/issues).

## License

Marina is released under the [MIT License](./LICENSE).
