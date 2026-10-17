<p align="center">
  <img src="assets/logo.png" alt="marina logo — 黄色橘子" width="112">
</p>

<h1 align="center">Marina — 本地数据库的码头</h1>

<p align="center">
  仓库：<a href="https://gitee.com/zhqi9277/marina">gitee.com/zhqi9277/marina</a> ·
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
- **版本号不写死**：仓库里没有版本清单。`marina remote` 运行时查询镜像/上游索引，缓存 6 小时；
  镜像顺序、TTL 都能用环境变量调整。
- **多版本共存**：`engines/<db>/<major>/<version>/`，同一 major 下可装多个小版本，
  `current` 软链指向激活版本，`use` 一条命令切换。
- **装完即用**：下载 → 校验 → 解压/编译 → 生成配置 → 初始化 datadir → 首次启动完成
  root 初始化 → 停止；之后 `start` 即可。
- **服务生命周期**：start / stop / restart / status / logs / port / auth，
  支持 `--all`、面板里的全部开启/关闭。
- **全屏面板**：TTY 下直接 `marina`，左右两栏，键盘驱动；Claude 风格暖橙配色。
- **凭据可改**：每个库的端口、账号、密码都能在面板里改；MySQL 系会同步 `ALTER USER`。
- **登录自启**：`a` / `A` 或 `marina autostart`，macOS LaunchAgent、Linux systemd --user。
- **本地隔离**：只监听 `127.0.0.1`，socket、pid、日志、数据全在 `runtime/` 下，删除即清理。
- **可迁移**：搬家后 `marina reconfig --all` 重写绝对路径；配置指向旧目录时启动会秒级报错。

Marina **不做**的事：开机自启（只做登录自启，见第 13 节）、远程管理、集群/复制、GUI。

---

## 2. 快速开始

### 2.1 要求

- Node.js **≥ 18.17**
- macOS（已实测）或 Linux（代码就绪，未真机端到端验证）
- 源码编译类引擎（PostgreSQL / Redis）需要 `make` + C 编译器；macOS 装 Xcode Command Line Tools
- 磁盘：每个引擎约 100–400 MB（含数据目录）

### 2.2 安装命令

```bash
git clone https://gitee.com/zhqi9277/marina.git
cd marina

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
╭─ 🍊 marina 0.1.0 ───────────────────────── 6 installed · runtime/ ─╮
│ DATABASES                  │ DETAIL                                │
├────────────────────────────┴──────────────────────────────────────┤
│▸ MySQL      8.4.11   ● 3306│ MySQL 8.4.11                          │
│  MariaDB    11.4.13  ○ 3307│ state    ● running                    │
│  PostgreSQL 17.11    ○ 5432│ port     127.0.0.1:3306               │
│  ...                       │ account  root                         │
│                            │ password root                         │
├────────────────────────────┴──────────────────────────────────────┤
│ ↑↓ move  enter actions  s/x/r start/stop/restart  S/X all  ...    │
│ · ready                                                           │
╰───────────────────────────────────────────────────────────────────╯
```

---

## 3. 目录与状态

默认运行时根目录是**仓库下的 `runtime/`**（可写时）；用 `MARINA_HOME` 可以改到别处，
从全局 npm 安装时回退到 `~/.marina`。

```
runtime/
  engines/<db>/<major>/<version>/   下载/编译出来的 payload
  engines/<db>/<major>/current      -> 激活版本软链
  data/<db>/<major>/                datadir，升级不覆盖
  etc/<db>/<major>/                 生成的配置（my.cnf / redis.conf / mongod.conf …）
  logs/<db>/<major>.log
  run/<db>-<major>.pid|.sock
  cache/<db>/<version>/*.tar.gz     已校验的下载缓存
  cache/index/<engine>.<os>.<arch>.json  远程版本索引缓存
  shims/<bin>                       PATH shims
  state.json                        激活版本、端口、设置
  state.lock                        写入 state.json 时的目录锁（退出即删）
```

`state.json` 的大致结构：

```json
{
  "version": 1,
  "active": { "mysql": "8.4.11", "redis": "7.4.11" },
  "ports": { "mysql:8.4": 3306, "redis:7": 6379 },
  "settings": {
    "mysqlRootPassword": "root",
    "accounts": {
      "mysql": { "user": "root", "password": "root" },
      "postgres": { "user": "postgres", "password": null }
    }
  }
}
```

- `active`：每个引擎当前激活的版本。
- `ports`：按 `engine:major` 存端口，同一 major 的多个小版本共用一个端口。
- `settings.accounts`：按引擎存账号密码；`mysqlRootPassword` 是旧字段，保留兼容。
- 删除 `state.json` 不会删数据，但会丢失激活版本、端口和凭据设置。
- 写入用 `runtime/state.lock` 目录锁 + 临时文件 rename 原子替换：两个 marina 进程同时改端口/自启不会互相覆盖；
  进程崩溃遗留的锁按 pid 与锁龄自动回收。
- `state.json` 以 `0600` 权限保存（密码明文，见第 17 节）。

---

## 4. 版本从哪来

`marina remote` 的处理链路：

```
远端目录 / JSON / tag feed
        │ 解析
        ▼
版本列表 ──平台/架构过滤──▶ 缓存 runtime/cache/index/*.json（TTL 6h）
        │
        ▼
install: HEAD 校验 → 下载 → 校验和 → 解压/编译
```

**仓库里没有硬编码的版本清单或逐版本下载地址。** 索引来源按优先级尝试，失败自动降级到下一个。

实测覆盖（2026-10）：

| 引擎 | 来源（按顺序） | 获取方式 | 校验和 | 备注 |
|---|---|---|---|---|
| PostgreSQL | 阿里云 → 腾讯云 → 华为云 → `ftp.postgresql.org` | 目录列表 | `.sha256` | 源码编译 |
| Redis | 华为云 → `download.redis.io/releases/` | 目录列表 | 无 | 源码编译 |
| MariaDB | 阿里云 → 腾讯云 → 华为云 | 目录列表 | `sha256sums.txt` | macOS 无官方二进制 |
| Memcached | 华为云 → `memcached.org/files/` | 目录列表 | 无 | 源码构建未自动化 |
| MySQL | 阿里云 / 华为云目录（≤ 8.0.x）→ GitHub `mysql-server` tag feed（8.4/9.x） | 目录 + tag feed | 官方 `.md5`（当前未消费） | 8.4+ 文件走 `cdn.mysql.com` |
| MongoDB | `downloads.mongodb.org/full.json` → `fastdl.mongodb.org` | JSON 索引 | JSON 内 `sha256` | 国内镜像无二进制 |

必须知道的几个约束：

- **国内镜像不带 MySQL 8.4**：阿里云/华为云目录停在 8.0.28/8.0.29。8.4/9.x 的版本号从官方
  `mysql-server` tag feed 发现，二进制从 `cdn.mysql.com` 取。
- **MongoDB 国内镜像没有二进制**：版本和文件都走官方 `full.json` + `fastdl`。
- **清华镜像不可用**：改版后目录/文件均 404，因此没有作为索引源。
- **镜像顺序可调**：`MARINA_MIRROR=huawei,aliyun marina remote`。
- **索引 TTL**：默认 21600 秒，`MARINA_INDEX_TTL` 可改；`--refresh` 强制重查。
- **平台过滤**：当前平台没有产物的版本会标 `n/a`，`install` 会给出原因；不会静默装错包。
- **校验和**：有 sha256 就校验（PG / MariaDB / MongoDB）；MySQL 只有官方 `.md5`（当前未消费），
  Redis/Memcached 上游没有官方 sha256，只校验下载完整性（大小/解压成功）。

### 自建产物 overlay

镜像缺平台（比如 macOS 的 MariaDB）时，可以自己做产物并让 marina 优先使用：

```bash
node scripts/make-manifest.mjs > manifest.json
MARINA_CATALOG_FILE=manifest.json marina install mariadb@11.4.13
# 或者
MARINA_CATALOG_URL=https://example.test/manifest.json marina install ...
```

命中 `(engine, version, os, arch)` 的 overlay 优先于远程索引；`os` 会做
`windows→win32`、`macos/osx→darwin` 归一化。

---

## 5. 平台支持

| 能力 | macOS | Linux | Windows |
|---|---|---|---|
| CLI / 版本切换 / 全屏面板 | ✅ 实测 | ⚠️ 代码就绪，未真机验证 | ⚠️ 代码就绪，未真机验证 |
| MySQL | ✅ 官方 tar.gz 实测 | ✅ 官方 `.tar.xz` | ✅ `.zip` |
| MongoDB | ✅ 官方 tgz 实测 | ✅ tgz | ✅ `.zip` |
| PostgreSQL | ✅ 源码编译实测 | ✅ 源码编译 | ❌ 源码需 MSVC，建议 WSL |
| Redis | ✅ 源码编译实测 | ✅ 源码编译 | ❌ 无官方 Windows 构建（WSL / Memurai） |
| MariaDB | ⚠️ 可列版本，本机不自动编译 | ⚠️ 同上 | ❌ |
| Memcached | ⚠️ 可列版本，本机不自动编译 | ⚠️ 同上 | ❌ |

平台差异集中在 `src/platform.js`：

- 包名/架构：darwin `…-macos15-arm64.tar.gz`、linux `…-linux-glibc2.28-aarch64.tar.xz`、win32 `…-winx64.zip`
- 解压：`.tar.gz/.tgz/.tar.xz/.zip` 按后缀选参数；Windows 无 bsdtar 时退回 PowerShell
- MySQL：Windows 无 unix socket，客户端/探活走 TCP
- PostgreSQL：Windows 省略 `-k`，不创建 socket 目录
- MongoDB：Windows 不支持 `--fork`，由 marina detach
- `current` 软链：Windows 退化为 junction/复制
- shims：Windows 生成 `.cmd`；`shellenv` 输出 PowerShell 语法
- 依赖检查：`otool -L` / `ldd`；Windows 跳过

Linux / Windows **尚未做真机端到端安装验证**。

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
| `marina install <db>[@ver]` | 下载/编译、初始化、写配置；默认切换 active |
| `marina install <db> --port 6380` | 安装时指定端口 |
| `marina install <db>@<ver> --file <pkg>` | 用本地包离线安装 |
| `marina install <db>@<ver> --no-use` | 装完不切换 active |

### 版本切换

| 命令 | 说明 |
|---|---|
| `marina use <db>@<ver>` | 切换激活版本（改 `current` 软链 + state） |
| `marina use <db>@<ver> --restart` | 切换后顺便重启 |
| `marina use` | 读取最近的 `.marinarc` 批量应用 |
| `marina current` | 显示激活版本与项目 pin |
| `marina ls` | 已安装版本 + 状态 + 端口 |

### 服务生命周期

| 命令 | 说明 |
|---|---|
| `marina start <db>[@ver]` | 启动；`--all` / `marina up --all` 全部 |
| `marina stop <db>[@ver]` | 停止；`--all` 全部 |
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
| `marina reconfig [db\|--all]` | 重写生成配置 + `current` 软链 |
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
| `MARINA_MIRROR` | 各引擎自带顺序（见第 4 节） | 索引/下载源顺序 |
| `MARINA_INDEX_TTL` | `21600` | 索引缓存秒数 |
| `MARINA_CATALOG_FILE` | — | 自建产物 overlay（本地 JSON） |
| `MARINA_CATALOG_URL` | — | 自建产物 overlay（HTTP） |
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
| Reconfig paths | 重写配置 + `current` 软链（目录搬家后用） |
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

每个引擎的凭据按 engine key 存在 `state.json → settings.accounts`，
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
- 改端口会：校验端口 → 停止（如果运行中）→ 写 state → 重写配置 → 重新启动。
- 改密码/账号会先保存，再尽量同步服务端；失败会在消息里给出原因。
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

```
远程索引 ──▶ cache/<db>/<ver>/*.tar.gz ──校验──▶ engines/<db>/<major>/<ver>/
   （镜像/上游）                                    │
                                        current 软链 ◀┘
                                                     │
 etc/<db>/<major>/*.conf ◀── 渲染（已存在不覆盖，--force 才重写）
 data/<db>/<major>/      ◀── 引擎初始化（mysqld --initialize-insecure / initdb / …）
 首次启动 ─▶ 设置 root 密码 / 清匿名用户 / 删 test 库 ─▶ 停止
```

- **major 深度**由 `src/catalog.js` 的 `majorDepth` 决定：
  MySQL `8.4.11→8.4`，PostgreSQL `17.11→17`，Redis `7.4.11→7`。
- **安装成功默认切换 active**，`--no-use` 可关。
- **配置不覆盖**：`etc/` 下已有文件默认保留，方便你改参数；`--force` / `reconfig` 才重写。
- **离线安装**：`--file` 直接给本地包，仍然走解压/初始化/配置流程。
- **overlay**：`MARINA_CATALOG_FILE/URL` 命中时优先于远程索引。
- **payload 自愈**：版本目录残缺（找不到 marker）时自动删除重解压；解压、重命名或源码编译失败会清理本次半成品，
  不会残留成“已安装”；`--force` 强制重新解包。
- **源码 vs 二进制**：PostgreSQL/Redis 本机编译；MySQL/MongoDB 解包官方二进制；
  MariaDB/Memcached 在 macOS 上只列版本，安装会明确拒绝（没有可用的自动化构建）。

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

macOS 使用用户级 LaunchAgent，Linux 使用 `systemd --user`，不需要 root：

```bash
marina autostart                 # 查看每个库的 on/off
marina autostart mysql redis     # 登录时启动这两个
marina autostart --all           # 全部已安装库
marina autostart --off mysql     # 关闭某个
marina autostart --off --all     # 全部关闭
```

- macOS 单元：`~/Library/LaunchAgents/com.marina.autostart.plist`
- Linux 单元：`~/.config/systemd/user/marina-autostart.service`
- 单元实际执行：`<node> <marina.js> start --autostart`，由 marina 读取
  `state.json → settings.autostart` 决定启动哪些库。
- 面板里：DETAIL 显示 `autostart on/off`，按 `a` 切换当前库，按 `A` 切换全部。
- 日志：`runtime/logs/autostart.log`。
- macOS 是**用户登录后**触发，不是开机即启；Linux 若要开机即使用户未登录，需要
  `loginctl enable-linger $USER`。

### 目录搬家

生成配置里是绝对路径，搬家后需要：

```bash
marina reconfig --all
marina restart <db>@<major>      # 或全部重启
```

- 启动前会检查配置里的路径；发现指向别的 marina 根目录会**立即报错**并提示 reconfig，
  不会干等 30 秒超时。
- 源码编译的 PostgreSQL 把绝对 prefix 编进了 install_name，搬家后 `pg_isready`/`psql`
  可能 dyld 报错；此时保留 datadir 重装二进制即可：

```bash
marina stop postgres@17
marina rm postgres@17            # 不 purge，datadir 还在
marina install postgres@17
marina start postgres@17
```

---

## 14. 故障排查

| 现象 | 原因 / 处理 |
|---|---|
| `zsh: command not found: marina` | 没进 PATH：`bash scripts/install-cli.sh`，或 `export PATH="$PWD/bin:$PATH"` |
| `degraded` | 有 pid 但探活失败：看 `marina logs`；常见是客户端二进制损坏、datadir 不可写、端口被别的东西占 |
| 启动卡 30 秒后失败 | 先看日志；如果是搬家后，配置里可能是旧路径，`marina reconfig <db>` |
| `port-busy` | 端口被非 marina 进程占用：`lsof -i :<port>`，或 `marina port <db> <新端口>` |
| `dyld: Library not loaded` | 源码编译的二进制被搬家/删库；重装该版本（保留 datadir） |
| `index unavailable` / 403 | 镜像临时不可用；`--refresh` 重试，或 `MARINA_MIRROR=huawei` 换源 |
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

- 远程索引解析（镜像 HTML、MySQL tag feed、MongoDB JSON）
- 版本排序、major 深度、平台过滤、overlay 归一化
- 配置路径过期检测（INI / YAML / redis.conf 三种指令）、启动快速失败
- 状态文件损坏归一化与 0600 权限、端口校验、下载完整性、Redis `requirepass`
- pid 归属校验与 stop 终止确认（含搬家后的旧进程、pid 复用防误杀）
- `state.json` 跨进程锁（3 进程并发自增不丢更新）、死锁/超时锁回收
- payload 复用 / 残缺自愈 / 解压与编译失败清理、`stopCommand` 失败告警
- Windows/systemd 纯函数加固：`current` 目录过滤、Expand-Archive 参数、systemd `%`/`$` 转义、非空目录替换
- settings / doctor / shims / registry / platform / configcheck / ui 的隔离 `MARINA_HOME` 行为
- TUI 按键、箭头导航、doctor、账号密码显示、端口/账号/密码输入
- 各引擎 `account()` 契约

目录：

| 文件 | 职责 |
|---|---|
| `src/cli.js` | 参数解析、命令分发、输出 |
| `src/catalog.js` | 引擎元数据 + 编译配方（不含版本号/URL） |
| `src/indexing.js` | 各引擎索引源与解析（目录 / tag feed / JSON） |
| `src/versions.js` | 索引缓存、平台过滤、版本选择、HEAD、校验和 |
| `src/installer.js` | 解析目标 → 下载/编译 → 配置 → 初始化 → 激活 |
| `src/lifecycle.js` | start/stop/status、探活、超时、启动前检查 |
| `src/settings.js` | 改端口/账号/密码与服务端同步 |
| `src/registry.js` | 引擎注册、版本发现、`buildCtx` |
| `src/engines/*.js` | 六个引擎的驱动 |
| `src/tui/*` | 全屏面板、绘制、按键 |
| `src/state.js` | `state.json` 读写、账号解析 |
| `src/overlay.js` | 自建产物 overlay |

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

2. `src/registry.js` 注册，`CONF_NAMES` 加配置文件名。
3. `src/catalog.js` 加元数据、`majorDepth`、平台、编译配方。
4. `src/indexing.js` 加索引源（目录解析或自定义 refresh）。
5. `test/` 加解析/驱动测试，跑 `npm test`。

---

## 16. 已知限制

- **MariaDB / Memcached 在 macOS 不自动安装**：镜像有源码，但没有 macOS 官方二进制，
  自动编译（cmake + boost / libevent）尚未实现；可用 `MARINA_CATALOG_FILE` 提供自建产物。
- **MySQL 8.4+ 国内镜像缺失**：版本号来自官方 tag feed，二进制来自 `cdn.mysql.com`，
  国内下载可能较慢。
- **校验和**：MySQL 只有官方 `.md5`（当前未消费）；Redis/Memcached 上游无 sha256。
- **PostgreSQL 列表包含全部历史版本**（数百个），建议 `--major 17` 过滤。
- **Windows / Linux 未真机验证**。
- **自启是“登录时”**：macOS 用 LaunchAgent（用户登录后触发），Linux 用 `systemd --user`；
  Windows 未实现（可用任务计划程序）。
- **不做认证管理**：MongoDB 的 `--auth`、PostgreSQL 的 pg_hba 不自动改。

---

## 17. 安全说明

- 所有服务默认只绑定 `127.0.0.1`，不要直接暴露到公网。
- 账号密码以明文存于 `runtime/state.json`（文件按 `0600` 写入），并会显示在 TUI/`marina auth`/`marina status` 中；
  这些是**本机开发凭据**，不要复用生产密码。
- MySQL 客户端参数里的 `-p<password>` 会出现在进程列表里（与官方客户端行为一致）。
- 下载包会尽量做 sha256 校验；没有官方校验和的引擎只能保证传输/解压完整。
- 安装脚本/编译在本机以当前用户权限执行，不调用 sudo。

---

<p align="center">
  <a href="https://gitee.com/zhqi9277/marina">Gitee</a> ·
  MIT License · © 2026 zhqi9277
</p>
