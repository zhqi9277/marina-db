<p align="center">
  <img src="assets/logo.png" alt="marina logo — 黄色橘子" width="112">
</p>

<h1 align="center">Marina — 本地数据库的码头</h1>

<p align="center">
  仓库：<a href="https://github.com/zhqi9277/marina-db">github.com/zhqi9277/marina-db</a> ·
  License: MIT · Node ≥ 18.17
</p>

> 每个数据库引擎占一个泊位：`up` 靠岸、`down` 离岸、`use` 换船（换版本）。
> 码头有泊位号，数据库有端口号；船停在码头不等于永远不走 —— 和你本机的六个实例一样。

Marina 是一个零依赖的本地数据库管理器：**装版本、切版本、启停服务、改端口/账号/密码、看日志**，
全部围绕一个隔离的 `runtime/` 目录完成，不碰系统的包管理器，也不需要 root。

支持的引擎：`mysql` · `mariadb` · `postgres` · `mongodb` · `redis` · `memcached`

---

## 目录

- [1. 特性](#1-特性)
- [2. 快速开始](#2-快速开始)
- [3. 目录与状态](#3-目录与状态)
- [4. 版本从哪来](#4-版本从哪来)
- [5. 平台支持](#5-平台支持)
- [6. 把 marina 变成命令](#6-把-marina-变成命令)
- [7. 命令参考](#7-命令参考)
- [8. 全屏面板](#8-全屏面板)
- [9. 端口 / 账号 / 密码](#9-端口--账号--密码)
- [10. 项目锁版本与 shims](#10-项目锁版本与-shims)
- [11. 安装流程](#11-安装流程)
- [12. 各引擎差异](#12-各引擎差异)
- [13. 数据、备份与迁移](#13-数据备份与迁移)
- [14. 故障排查](#14-故障排查)
- [15. 开发与测试](#15-开发与测试)
- [16. 已知限制](#16-已知限制)
- [17. 安全说明](#17-安全说明)

---

## 1. 特性

- **零依赖**：只用 Node 内置模块，`npm test` 不需要装任何东西，也没有构建步骤。
- **预编译引擎**。`marina remote` 读取 GitHub 发布清单，显示适配本机的版本。
- **多版本共存**：`engines/<db>/<major>/<version>/`，同一 major 下可装多个小版本，
- **装完即用**：下载 → 校验 → 解压 → 生成配置 → 初始化 datadir → 首次启动完成
  root 初始化 → 停止；之后 `start` 即可。
- **服务生命周期**：start / stop / restart / status / logs / port / auth，
  支持 `--all`、面板里的全部开启/关闭。
- **全屏面板**：TTY 下直接 `marina`，左右两栏，键盘驱动；Claude 风格暖橙配色。
- **凭据可改**：每个库的端口、账号、密码都能在面板里改；MySQL 系会同步 `ALTER USER`。
- **登录自启**：`a` / `A` 或 `marina autostart`，macOS LaunchAgent、Linux systemd --user、Windows 登录计划任务。
- **本地隔离**：只监听 `127.0.0.1`，socket、pid、日志、数据全在 `runtime/` 下，删除即清理。
- **可迁移**：配置不保存绝对路径，移动仓库前先停止服务；搬到新位置后直接启动即可。

Marina **不做**的事：开机自启（只做登录自启，见第 13 节）、远程管理、集群/复制、GUI。

---

## 2. 快速开始

### 2.1 要求

- Node.js **≥ 18.17**
- macOS 15、Ubuntu 22.04 或 Windows Server 2022。架构见[平台支持](#5-平台支持)。
- 安装时需要为下载归档和解压后的文件预留磁盘空间。

### 2.2 安装命令

```bash
git clone https://github.com/zhqi9277/marina-db.git
cd marina-db

# 方式 A（推荐）：装到 ~/.local/bin，无需 sudo
bash scripts/install-cli.sh
exec zsh
marina --version

# 方式 B：npm link
npm link

# 方式 C：只对当前 shell 生效
export PATH="$PWD/bin:$PATH"
```

详见[第 6 节](#6-把-marina-变成命令)。

### 2.3 装第一个数据库

```bash
marina remote                 # 六个引擎各有多少版本、最新几个、索引来源
marina remote mysql           # 某个引擎的完整版本表
marina install mysql@8.4      # 指定 major 或完整版本
marina install redis          # 不写版本 → TTY 里从列表选
marina start mysql@8.4
marina start mysql redis          # 一次启动多个
marina exec mysql@8.4 -- -e "select version()"
marina ls
```

### 2.4 打开面板

```bash
marina            # TTY 进入全屏面板；管道/CI 下打印帮助，不会卡住
```

面板结构：

```
╭─ 🍊 marina 0.1.0 ───────────────────────── 6 installed ` runtime/ ─╮
│ DATABASES                  │ DETAIL                                │
├────────────────────────────┴──────────────────────────────────────┤
│▸ MySQL      8.4.11   ● 3306│ MySQL 8.4.11                          │
│  MariaDB    11.4.13  ○ 3307│ state    ● running                    │
│  PostgreSQL 17.11    ○ 5432│ port     127.0.0.1:3306               │
│  ...                       │ account  root                         │
│                            │ password root                         │
├────────────────────────────┴──────────────────────────────────────┤
│ ↑↓ move  enter actions  s/x/r start/stop/restart  S/X all  ...    │
│ ` ready                                                           │
╰───────────────────────────────────────────────────────────────────╯
```

---

## 3. 目录与状态

默认运行时根目录是**仓库下的 `runtime/`**（可写时）；用 `MARINA_HOME` 可以改到别处，
从全局 npm 安装时回退到 `~/.marina`。

```
runtime/
  engines/<db>/<major>/<version>/   解压后的引擎文件
  data/<db>/<major>/                datadir，升级不覆盖
  etc/<db>/<major>/                 生成的配置（my.cnf / redis.conf / mongod.conf …）
  logs/<db>/<major>.log
  run/<db>-<major>.pid|.sock|.service.json  进程、套接字与实际运行版本
  cache/<db>/<version>/*.tar.gz     已校验的下载缓存
  cache/index/catalog-<hash>.json  按清单 URL 缓存的版本索引
  shims/<bin>                       PATH shims
  state.json                        激活版本、端口、设置
  state.lock                        写入 state.json 时的目录锁（退出即删）
```

`state.json` 的大致结构：

```json
{
  "version": 1,
  "active": { "mysql": "8.4.11", "redis": "7.4.11" },
  "selected": { "mysql:8.4": "8.4.11", "redis:7": "7.4.11" },
  "ports": { "mysql:8.4": 3306, "redis:7": 6379 },
  "settings": {
    "mysqlRootPassword": "root",
    "instanceAccounts": {
      "mysql:8.4": { "user": "root", "password": "root" },
      "postgres:17": { "user": "postgres", "password": null }
    }
  }
}
```

- `active`：每个引擎在未指定版本时使用的默认版本。
- `selected`：每条 `engine:major` 版本线选择的版本。正在运行的版本由运行记录和进程信息确定。
- `ports`：按 `engine:major` 存端口，同一 major 的多个小版本共用一个端口。
- `settings.instanceAccounts`：按 `engine:major` 存账号密码。旧版的 `settings.accounts` 和 `mysqlRootPassword` 继续作为兼容默认值。
- 删除 `state.json` 不会删数据，但会丢失激活版本、端口和凭据设置。
- 写入用 `runtime/state.lock` 目录锁 + 临时文件 rename 原子替换：两个 marina 进程同时改端口/自启不会互相覆盖；
  进程崩溃遗留的锁按 pid 与锁龄自动回收。
- `state.json` 以 `0600` 权限保存（密码明文，见第 17 节）。

---

## 4. 版本从哪来

默认清单存放在 GitHub 的 `engine-catalog` 分支，归档由 [GitHub Releases](https://github.com/zhqi9277/marina-db/releases) 提供。`marina remote` 和终端面板仅列出本机可安装的版本。指定完整版本时精确匹配，指定系列时选择最新补丁，非交互式省略版本时优先使用引擎的默认系列。

清单默认缓存 6 小时，可用 `MARINA_INDEX_TTL` 调整。`marina remote --refresh` 立即重新读取。若指定版本缺失，安装命令会列出可用版本。

`MARINA_CATALOG_FILE=/path/manifest.json` 或 `MARINA_CATALOG_URL=https://example.test/manifest.json` 可覆盖默认清单。已有归档可用 `marina install redis@7.4.11 --file /path/to/archive.tar.gz` 直接安装。

---

## 5. 平台支持

| 平台 | 目标架构 | 验收环境 |
|---|---|---|
| macOS | Apple Silicon、Intel | macOS 15 |
| Linux | x64、ARM64 | Ubuntu 22.04 |
| Windows | x64 | Windows Server 2022 |

首批构建 MySQL 8.4.11、MariaDB 11.4.13、PostgreSQL 17.11、MongoDB 7.0.45、Redis 7.4.11 和 Memcached 1.6.45。Windows 使用 Redis 便携版及 Memcached 1.6.8 便携版。

---

## 6. 把 marina 变成命令

项目不会自动进 PATH，直接敲 `marina` 会 `command not found`（zsh 也不搜索当前目录）。

**A. 安装到 `~/.local/bin`（推荐，无需 sudo）**

```bash
bash scripts/install-cli.sh
exec zsh
marina --version
```

脚本生成 `~/.local/bin/marina`，直接运行当前 checkout（改代码立即生效）。
仓库搬家后重跑一次；`MARINA_BIN_DIR=/usr/local/bin bash scripts/install-cli.sh` 可改目标目录。

**B. npm link**

```bash
npm link        # nvm 用户同样不需要 sudo
```

**C. 临时生效**

```bash
export PATH="$PWD/bin:$PATH"
# 或者直接
./bin/marina --version
```

---

## 7. 命令参考

### 版本发现与安装

| 命令 | 说明 |
|---|---|
| `marina remote` | 六个引擎的版本摘要（数量、最新几个、索引来源） |
| `marina remote <db>` | 单个引擎的完整版本表 |
| `marina remote <db> --major 8.0` | 只看某个 major |
| `marina remote <db> --installed` | 只列已安装 |
| `marina remote --json` | 机器可读输出 |
| `marina remote --refresh` | 强制重查索引 |
| `marina install <db>[@ver]` | 下载、校验、解压、初始化、写配置；默认切换 active |
| `marina install <db> --port 6380` | 安装时指定端口 |
| `marina install <db>@<ver> --file <pkg>` | 用本地包离线安装 |
| `marina install <db>@<ver> --no-use` | 装完不切换 active |

### 版本切换

| 命令 | 说明 |
|---|---|
| `marina use <db>@<ver>` | 切换激活版本并更新 state |
| `marina use <db>@<ver> --restart` | 切换后顺便重启 |
| `marina use` | 读取最近的 `.marinarc` 批量应用 |
| `marina current` | 显示激活版本与项目 pin |
| `marina ls` | 已安装版本 + 状态 + 端口 |

### 服务生命周期

| 命令 | 说明 |
|---|---|
| `marina start <db>[@ver]` | 启动；`--all` 启动各引擎的默认版本 |
| `marina stop <db>[@ver]` | 停止；省略完整版本时操作当前实例实际运行的版本，`--all` 覆盖所有已装版本线 |
| `marina restart <db>[@ver]` | 重启 |
| `marina status [db...]` | 一个或多个；`--json` 含 `auth` |
| `marina logs <db> --lines 200` | 日志尾部 |
| `marina config <db>` | 配置路径 |
| `marina doctor` | 环境自检；`--json` 输出检查项 |

### 配置与凭据

| 命令 | 说明 |
|---|---|
| `marina port <db> [N]` | 读/改端口；自动重写配置，运行中自动重启 |
| `marina auth <db>` | 查看账号、密码、认证方式 |
| `marina auth <db> <user> <password>` | 修改并尽量同步服务端 |

| `marina rm <db>[@ver]` | 卸载版本；`--purge` 连 datadir |

### 客户端与工具

| 命令 | 说明 |
|---|---|
| `marina exec <db> -- <args>` | 用该版本客户端执行，自动带账号/端口/socket |
| `marina which <bin>` | 解析客户端二进制路径 |
| `marina shims` | 生成 `<runtime>/shims/*` |
| `marina shellenv` | `eval "$(marina shellenv)"` |
| `marina menu` | 等价于直接 `marina` |

### 全局 flags

```
--json        机器可读
--force       重写配置 / 重新解压
--all         所有已安装数据库
--purge       连 datadir 一起删
--refresh     强制重查远程索引
--use/--no-use  安装后是否切换 active
--major M --installed  过滤 remote 列表
--port N --file PATH --version V --lines N --user U --password P
```

### 环境变量

| 变量 | 默认 | 作用 |
|---|---|---|
| `MARINA_HOME` | 仓库 `runtime/`（可写时）或 `~/.marina` | 运行时根目录 |
| `MARINA_INDEX_TTL` | `21600` | 索引缓存秒数 |
| `MARINA_CATALOG_FILE` | — | 覆盖默认 GitHub 清单（本地 JSON） |
| `MARINA_CATALOG_URL` | — | 覆盖默认 GitHub 清单（HTTP） |
| `MARINA_DEBUG` | — | CLI 打印完整错误栈 |

---

## 8. 全屏面板

TTY 下 `marina` 进入面板；非 TTY 打印帮助，避免 CI 卡住。状态每 2.5 秒刷新。

### 按键

| 键 | 作用 |
|---|---|
| `↑ ↓` / `j k` | 移动选择 |
| `enter` | 打开 ACTIONS 菜单 |
| `s` / `x` / `r` | 启动 / 停止 / 重启当前库 |
| `S` / `X` | 全部开启 / 全部关闭 |
| `v` | 版本列表：已安装可激活，远程版本可安装 |
| `l` | 日志（↑↓ 滚动、PgUp/PgDn、`r` 重载） |
| `c` | 打印配置路径 |
| `y` | 打印客户端命令 |
| `d` | doctor 自检视图（`g` 重跑） |
| `a` / `A` | 当前库 / 全部库：切换登录自启 |
| `g` | 刷新 |
| `1…6` | 跳到某个数据库 |
| `?` | 键位帮助 |
| `q` | 退出 |

### ACTIONS 菜单

| 操作 | 说明 |
|---|---|
| Start / Stop / Restart | 当前库 |
| Start all / Stop all | 所有已安装库，逐个执行，失败会列第一条错误 |
| Doctor | 本地自检：platform / node / tar / MARINA_HOME / index / libs / ports |
| Change port | 输入新端口，自动重写配置，运行中自动重启 |
| Set user | 输入新账号；MySQL 系会创建用户并授权 |
| Set password | 掩码输入；MySQL 系执行 `ALTER USER`，Redis 写 `requirepass` |
| Show logs / Versions / Config / Client | 与快捷键等价 |
| Back | 返回 |

### 输入界面

- `enter` 应用，`esc` 取消，`backspace` 删除，`ctrl-u` 清空
- 密码用 `•` 掩码；空值表示清除密码
- 应用期间显示 spinner，完成后回到 DETAIL 并刷新

### 颜色

- 已下载的库名：**Claude 橙**
- 未下载：灰色 + `not inst.` + 黄色 `↓`
- 版本列表：`◉` 绿色 = 已安装，`↓` 黄色 = 可下载
- 状态：`●` 运行、`◐` degraded、`○` 停止、`◌` 非激活、`◑` 端口被占

---

## 9. 端口 / 账号 / 密码

每个实例的凭据按 `engine:major` 存在 `state.json → settings.instanceAccounts`，
`marina status`、面板 DETAIL、`marina auth` 都读同一份。

| 引擎 | 默认账号 | 默认密码 | 修改密码时的行为 |
|---|---|---|---|
| MySQL | `root` | `root` | 运行中执行 `ALTER USER`；改用户名会 `CREATE USER` + 授权 |
| MariaDB | `root` | `root` | 同上 |
| PostgreSQL | `postgres` | 无（trust） | 运行中执行 `ALTER ROLE`，但 pg_hba 仍是 trust，密码不会强制校验 |
| Redis | — | 无 | 写入 `requirepass` 并重启；client/probe/stop 自动带 `-a` |
| MongoDB | — | 无 | 只保存；client 会带 `-u/-p`，marina 不开启 `--auth` |
| Memcached | — | 无 | 只保存（引擎本身无认证） |

注意事项：

- **MySQL / MariaDB / PostgreSQL 停止时拒绝改密码**：服务端没运行就无法 `ALTER`，
  强行保存会让 marina 用新密码去探活/停止，反而更糟。先 `start`，再改。
- 改端口会校验端口，重写配置，并在需要时重启实例。成功后保存端口，失败时尝试恢复原配置和进程。
- MySQL 系和 PostgreSQL 的服务端更新成功后保存凭据。Redis 在写入配置以及必要的重启成功后保存。
- 密码以**明文**存在 `state.json`，也会在 TUI/CLI 里显示 —— 这是本机开发工具，别用它管生产库。

---

## 10. 项目锁版本与 shims

### `.marinarc`

在项目根放一个 JSON，记录每个库想要的版本：

```json
{ "mysql": "8.4", "redis": "7" }
```

```bash
cd my-project
marina use            # 按 .marinarc 切换
marina current        # 显示当前版本与 pin
```

`marina use` 会向上查找最近的 `.marinarc`。

### shims

```bash
eval "$(marina shellenv)"      # 把 <runtime>/shims 放进 PATH
mysql -uroot -proot -e "select 1"
redis-cli ping
```

shim 会根据“当前激活版本 + 该 major 的端口/socket”把命令转给正确的客户端二进制，
换版本后不需要重新 `source`。

---

## 11. 安装流程

从清单选择版本，下载并校验归档，再解压至 `engines/<db>/<major>/<version>/`。Marina 初始化数据目录、完成首次启动及账号初始化后停止服务。安装成功会切换活动版本，`--no-use` 保留当前选择。

- 主要版本目录决定数据和配置的路径，例如 MySQL `8.4.11→8.4`、PostgreSQL `17.11→17`、Redis `7.4.11→7`。
- 已有配置默认保留。同一版本线已有服务运行时，安装保留运行中的进程，`status` 可区分已选择版本和正在运行版本。
- 版本目录缺少可执行文件时重新解包。解包失败会清理暂存目录。`--force` 可重新解包。
- 客户端与服务进程会过滤 `PGHOST`、`MYSQL_HOST`、`REDISCLI_AUTH` 和动态库加载等环境变量；`marina doctor` 可检查已安装二进制的依赖。

---

## 12. 各引擎差异

| 引擎 | 默认端口 | 初始化 | 启动 | 停止 | 探活 |
|---|---|---|---|---|---|
| MySQL | 3306 | `mysqld --initialize-insecure` | `mysqld --defaults-file`（后台） | `mysqladmin shutdown` | client ping → TCP |
| MariaDB | 3307 | `mariadb-install-db` | `mariadbd --defaults-file` | `mariadb-admin shutdown` | client ping → TCP |
| PostgreSQL | 5432 | `initdb -U postgres --auth=trust` | `pg_ctl … -w start` | `pg_ctl -m fast -w stop` | `pg_isready` → TCP |
| MongoDB | 27017 | 建目录即可 | `mongod --fork --pidfilepath` | SIGTERM | `mongosh --eval ping` → TCP |
| Redis | 6379 | 无 | `redis-server <conf>`（daemonize） | `redis-cli shutdown save` | `redis-cli ping` → TCP |
| Memcached | 11211 | 无 | `memcached -d -P <pid>` | SIGTERM | TCP |

二进制定位不写死路径：按 `bin/ → sbin/ → scripts/ → libexec/ → lib/` 找标记文件，
找不到再做 BFS，兼容 `8.4.11/bin/...` 与 `bin/...` 两种 tar 布局。

探活策略：引擎自带探针优先（如 `pg_isready`、`redis-cli ping`）；探针返回
“工具坏了/不存在”时回退 TCP，避免因为客户端二进制损坏把运行中的服务误判为停止。

---

## 13. 数据、备份与迁移

### 数据在哪

```
runtime/data/<db>/<major>/
runtime/etc/<db>/<major>/
runtime/logs/<db>/<major>.log
```

MySQL/MariaDB/PostgreSQL/MongoDB 的数据都在 datadir；Redis 的 `dump.rdb` 在
`runtime/data/redis/<major>/`。

### 备份

```bash
marina stop mysql@8.4
cp -a runtime/data/mysql/8.4 ~/backup/mysql-8.4-$(date +%F)
marina start mysql@8.4
```

### 卸载

```bash
marina rm redis@7.2.5            # 只删这个版本的 payload，保留 datadir
marina rm redis@7 --purge        # 连 datadir 一起删（不可恢复）
```

### 登录自启

macOS 使用用户级 LaunchAgent，Linux 使用 `systemd --user`，Windows 使用当前用户的登录计划任务，都不需要管理员：

```bash
marina autostart                 # 查看每个库的 on/off
marina autostart mysql redis     # 登录时启动这两个
marina autostart --all           # 全部已安装库
marina autostart --off mysql     # 关闭某个
marina autostart --off --all     # 全部关闭
```

- macOS 单元：`~/Library/LaunchAgents/com.marina.autostart.plist`
- Linux 单元：`~/.config/systemd/user/marina-autostart.service`
- Windows 任务：`marina-autostart`，定义文件在 `%APPDATA%\marina\marina-autostart.xml`，触发器是登录（`ONLOGON`）
- 单元实际执行：`<node> <marina.js> start --autostart`，由 marina 读取
  `state.json → settings.autostart` 决定启动哪些库。
- 面板里：DETAIL 显示 `autostart on/off`，按 `a` 切换当前库，按 `A` 切换全部。
- 日志：`runtime/logs/autostart.log`。
- 三个系统都是**用户登录后**触发，不是开机即启；Linux 若要开机即使用户未登录，需要
  `loginctl enable-linger $USER`。

### 目录搬家

生成配置不保存绝对路径，启动参数会在启动时传入当前根目录、端口、
数据目录、pid 和日志位置。移动仓库时先停止服务，搬家后直接启动即可：

```bash
marina stop --all
# 搬运仓库
marina start --all
```

- PostgreSQL / Redis 源码包若包含写死的绝对构建路径，可重装该版本；
  通常不需要迁移或重写 datadir。

---

## 14. 故障排查

| 现象 | 原因 / 处理 |
|---|---|
| `zsh: command not found: marina` | 没进 PATH：`bash scripts/install-cli.sh`，或 `export PATH="$PWD/bin:$PATH"` |
| `degraded` | 有 pid 但探活失败：看 `marina logs`；常见是客户端二进制损坏、datadir 不可写、端口被别的东西占 |
| 启动卡 30 秒后失败 | 先看日志；移动仓库前应先停止服务，重启时会使用新运行时路径 |
| `port-busy` | 端口被非 marina 进程占用：`lsof -i :<port>`，或 `marina port <db> <新端口>` |
| `dyld: Library not loaded` | 引擎依赖缺失。检查 `marina doctor`，然后重装已发布的同版本。 |
| `doctor` 的 `libs` 报 `(outside install)` | 这个包依赖了安装目录和系统之外的库，换一台机器就起不来：重装一个自包含的包（`scripts/build-engine.sh`） |
| `engine catalog` / HTTP 错误 | 检查 GitHub 是否可访问并运行 `marina remote --refresh`。离线时可用 `--file` 安装已有归档。 |
| 校验和不匹配 | 缓存损坏：删 `runtime/cache/<db>/<ver>/` 后重装 |
| `Access denied` | `marina auth <db>` 看保存的凭据；MySQL 系可用正确密码重新设置 |
| TUI 方向键不动 | 终端把方向键发成应用模式序列；用 `j/k` 代替 |
| 面板显示 `not inst.` | 这个引擎还没装任何版本：`v` 选版本安装，或 `marina install <db>` |

调试：

```bash
MARINA_DEBUG=1 marina start mysql@8.4   # 打印完整错误栈
marina doctor --json                    # 检查项机器可读
```

---

## 15. 开发与测试

```bash
npm test          # node --test test/*.mjs，当前离线，不联网
npm run marina -- remote   # 不装全局时直接跑
```

测试覆盖：

- 版本排序、major 深度、GitHub 清单缓存与平台过滤
- 配置路径过期检测（INI / YAML / redis.conf 三种指令）、启动快速失败
- 状态文件损坏归一化与 0600 权限、端口校验、下载完整性、Redis `requirepass`
- pid 归属校验与 stop 终止确认（含搬家后的旧进程、pid 复用防误杀）
- `state.json` 跨进程锁（3 进程并发自增不丢更新）、死锁/超时锁回收
- payload 复用 / 残缺自愈 / 解压失败清理、`stopCommand` 失败告警
- settings / doctor / shims / registry / platform / host / configcheck / ui 的隔离 `MARINA_HOME` 行为
- TUI 按键、箭头导航、doctor、账号密码显示、端口/账号/密码输入
- 各引擎 `account()` 契约

目录：

| 文件 | 职责 |
|---|---|
| `src/cli.js` | 唯一根模块：参数解析、命令分发、输出 |
| `src/core/` | 路径、平台门面、环境、状态、注册表和项目配置 |
| `src/install/` | 版本索引、下载、解包、产物检查与安装 |
| `src/runtime/` | 生命周期、配置、账号端口、状态查看、自启与诊断 |
| `src/host/` | 全系统宿主：进程、信号、路径、shell、登录自启 |
| `src/engines/*.js` | 六个引擎的驱动 |
| `src/tui/` | 全屏面板状态、绘制、按键与视图 |
| `src/ui/` | CLI 颜色、表格、消息和交互输出 |

### 构建和发布引擎

1. 运行 `node scripts/engine-history.mjs` 对照上游发行记录和正式清单，查看各版本已发布及待验收的架构。
2. 在 `scripts/engine-batches/<批次>.json` 登记本批的版本、目标平台以及上游 URL 和 SHA-256。推送 `engines-candidate-<批次>--<提交短哈希>` 标签启动构建。每批单独生成 GitHub Release 和清单，验收会核对实际运行的版本。
3. 以合并提交方式将候选提交纳入 `main`，然后运行 `promote-engines`，输入通过验收的运行 ID。工作流按批次核对覆盖范围和摘要，将新版本加入 `engine-catalog`。回滚可还原该分支上的上一次发布提交。

在目标环境可以用 `node scripts/package-engine.mjs redis 7.4.11 dist` 单独构建一个归档。macOS 的额外构建工具目录通过 `MARINA_BUILD_PATH` 指定，MariaDB 的 OpenSSL 3 开发库目录通过 `MARINA_OPENSSL_ROOT` 指定。依赖检查会在搬动安装目录后执行。更新版本时，同时修改构建矩阵和输入校验值。

### 加一个新引擎

1. 写 `src/engines/xxx.js`：

```js
export default {
  key: 'xxx', label: 'XXX', manifestName: 'xxx',
  defaultMajor: '1.0', defaultPort: 12345,
  markers: ['bin/xxxd'], serverBin: ['xxxd'],
  clientBins: ['xxx-cli'], primaryClient: 'xxx-cli',
  renderConfig(ctx) { return `port ${ctx.port}\ndir ${ctx.dataDir}\n`; },
  startArgs(ctx) { return [ctx.confFile]; },
  stopCommand(ctx) { return { cmd: '...', args: [...] }; },  // null → SIGTERM
  async init(ctx) {},
  async probe(ctx) { return null; },                          // null → 回退 TCP
  account(ctx) { return { user: null, password: null, mode: 'disabled' }; },
};
```

2. `src/core/registry.js` 注册，`CONF_NAMES` 加配置文件名。
3. `src/install/catalog.js` 注册清单名和 `majorDepth`。
4. 在 `scripts/engine-matrix.mjs` 登记版本，在 `scripts/engine-sources.mjs` 固定上游包及校验值。
5. 运行 `npm test`，再用候选发布验证目标平台。

---

## 16. 已知限制

- 某个版本能否安装取决于当前平台的已发布清单，可用 `marina remote <db>` 查看。
- Windows Redis 与 Memcached 由 Marina 管理便携进程。
- MariaDB 默认归档用于单实例运行。使用 Galera、OQGraph、CrackLib 或 CONNECT 时，可通过 `--file` 安装包含所需组件的归档。
- 登录自启使用 LaunchAgent、`systemd --user` 或 Windows 登录计划任务。
- MongoDB 的 `--auth`、PostgreSQL 的 `pg_hba.conf` 由用户管理。

---

## 17. 安全说明

- 所有服务默认只绑定 `127.0.0.1`，不要直接暴露到公网。
- 账号密码以明文存于 `runtime/state.json`（文件按 `0600` 写入），并会显示在 TUI/`marina auth`/`marina status` 中；
  这些是**本机开发凭据**，不要复用生产密码。
- MySQL 客户端参数里的 `-p<password>` 会出现在进程列表里（与官方客户端行为一致）。
- GitHub 下载包在解压前校验清单中的字节数和 SHA-256。
- 安装和服务进程均以当前用户权限运行。

---

<p align="center">
  <a href="https://github.com/zhqi9277/marina-db">GitHub</a> ·
  MIT License · © 2026 zhqi9277
</p>
