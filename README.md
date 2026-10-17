<p align="center">
  <img src="assets/logo.png" alt="marina logo — 黄色橘子" width="112">
</p>

<h1 align="center">Marina — 本地数据库的码头</h1>

<p align="center">
  仓库：<a href="https://gitee.com/zhqi9277/marina">gitee.com/zhqi9277/marina</a>
</p>

> 每个数据库引擎占一个泊位：`up` 靠岸、`down` 离岸、`use` 换船（换版本）。
> 码头有泊位号，数据库有端口号；船停在码头不等于永远不走 —— 和你本机的六个实例一样。

安装、切换、运行本地数据库引擎：一条 CLI 管六个引擎，版本号运行时从镜像查，运行态全部隔离在自己的目录里。

- **零依赖**：只用 Node 内置模块，没有构建步骤
- **版本不写死**：`marina remote` 实时查询阿里云 / 腾讯 / 华为 / 官方索引，结果缓存 6 小时
- **装完即用**：自动初始化 datadir、生成配置、首次启动完成 root 初始化
- **一条命令切换**：`marina use mysql@8.4` 改软链 + 记录状态，客户端 shims 自动跟随
- **全屏面板**：TTY 下直接 `marina`，启停、版本、日志不用记命令
- **本地隔离**：只监听 127.0.0.1，所有数据在 `runtime/`，删除即清理

Node ≥ 18，macOS / Linux（Windows 见[平台支持](#平台支持)）。
支持：`mysql` · `mariadb` · `postgres` · `mongodb` · `redis` · `memcached`

**版本号不在本地写死**：每个引擎有哪些版本、从哪下载，都是运行时从镜像/上游索引里查出来的（见下一节）。

---

## 一、版本从哪来（远程索引）

`marina remote` 做的事：按引擎逐个访问远端目录/索引 → 解析出版本列表 → 缓存到
`runtime/cache/index/<engine>.<platform>.<arch>.json`（TTL 6 小时，`--refresh` 强制重取）。
缓存只是"上次查询结果"，随时可删；仓库里没有任何版本清单。

优先级：**国内镜像 → 官方上游**。实测覆盖（2026-10）：

| 引擎 | 版本/文件来源（按顺序尝试） | 获取方式 | 校验和 |
|---|---|---|---|
| PostgreSQL | 阿里云 → 腾讯云 → 华为云 → `ftp.postgresql.org/pub/source/` | 目录列表 | `.sha256` |
| Redis | 华为云 → `download.redis.io/releases/` | 目录列表 | 无（可用 redis-hashes） |
| MariaDB | 阿里云 → 腾讯云 → 华为云 | 目录列表 | `sha256sums.txt` |
| Memcached | 华为云 → `memcached.org/files/` | 目录列表 | 无 |
| MySQL | 阿里云 / 华为云目录（≤ 8.0.x）→ GitHub `mysql-server` tag feed（8.4/9.x） | 目录列表 + tag feed | 官方 `.md5` |
| MongoDB | `downloads.mongodb.org/full.json` → `fastdl.mongodb.org` | JSON 索引 | JSON 内 `sha256` |

三个必须知道的事实：

- **国内镜像不带 MySQL 8.4**：阿里云/腾讯/华为的 MySQL 目录停留在 8.0.28/8.0.29。8.4+ 的**版本号**从官方 tag feed 发现，**文件**从 `cdn.mysql.com` 取。
- **MongoDB 二进制国内镜像没有**（只有 apt/yum 仓库）：版本和文件都走官方 `full.json` + `fastdl`。
- **清华镜像站改版后目录/文件均 404**，因此不作为索引源。
- 索引源顺序可用 `MARINA_MIRROR=huawei,aliyun` 调整（默认 aliyun → tencent → huawei → 上游）。

源码类引擎（PostgreSQL / Redis）从镜像拿源码包在本机编译；MySQL / MongoDB 直接解包官方二进制。

---

## 二、平台支持

| 能力 | macOS | Linux | Windows |
|---|---|---|---|
| CLI / 版本切换 / 全屏面板 | ✅ 实测 | ⚠️ 代码就绪，未真机验证 | ⚠️ 代码就绪，未真机验证 |
| MySQL | ✅ 官方 tar.gz 实测 | ✅ 官方 `.tar.xz` | ✅ `.zip` |
| MongoDB | ✅ 官方 tgz 实测 | ✅ tgz | ✅ `.zip` |
| PostgreSQL | ✅ 源码编译实测 | ✅ 源码编译 | ❌ 源码需 MSVC，建议 WSL |
| Redis | ✅ 源码编译实测 | ✅ 源码编译 | ❌ 无 Windows 构建（用 WSL / Memurai） |
| MariaDB | ⚠️ 可列版本，本机不自动编译 | ⚠️ 同上 | ❌ |
| Memcached | ⚠️ 可列版本，本机不自动编译 | ⚠️ 同上 | ❌ |

平台差异都收在 `src/platform.js` 一处：

- **包名/架构**：darwin `mysql-…-macos15-arm64.tar.gz`、linux `…-linux-glibc2.28-aarch64.tar.xz`、win32 `…-winx64.zip`
- **解压**：`.tar.gz/.tgz/.tar.xz/.zip` 按后缀选参数；Windows 没有 bsdtar 时退回 PowerShell `Expand-Archive`
- **MySQL**：Windows 无 unix socket → 配置不写 `socket`，客户端/探活走 `--protocol=TCP`
- **PostgreSQL**：Windows 不支持 `-k`，自动省略；socket 目录只在类 Unix 上创建
- **MongoDB**：Windows 不支持 `--fork`，改由 marina 自己 detach
- **链接**：`current` 软链在 Windows 退化为 junction / 复制
- **shims**：Windows 生成 `.cmd`；`marina shellenv` 在 Windows 输出 PowerShell 语法
- **依赖检查**：`otool -L`（macOS）/ `ldd`（Linux）/ Windows 跳过
- **平台拦截**：`marina remote` 对当前平台没有产物的版本标 `n/a`；`install` 给出原因

Linux / Windows **尚未在真机上做端到端安装验证**。

---

## 三、把 marina 变成命令

项目本身不会自动进 PATH，所以直接敲 `marina` 会 `command not found`（zsh 也不会搜索当前目录）。
任选一种方式装上；A 一次装好，之后在本目录或任何目录都能直接用。

**A. 安装到 `~/.local/bin`（推荐，无需 sudo）**

```bash
bash scripts/install-cli.sh
exec zsh                  # 或 source ~/.zshrc
marina --version
```

脚本会生成 `~/.local/bin/marina`，它直接运行当前 checkout（改代码立即生效）；
仓库移动后重跑一次即可。想装到别处：`MARINA_BIN_DIR=/usr/local/bin bash scripts/install-cli.sh`。

**B. npm link**

```bash
npm link                  # 用 nvm 的话同样不需要 sudo
marina --version
```

**C. 只在当前 shell 临时生效**

```bash
export PATH="$PWD/bin:$PATH"
marina --version
```

`bin/marina` 是仓库自带的 shell 入口（会转交给 `node bin/marina.js`）；
不改 PATH 时也可以直接 `./bin/marina ...`。

---

## 四、快速开始

```bash
marina --help

marina remote                      # 6 个引擎各有多少版本、最新几个、索引来源
marina remote mysql                # MySQL 的完整版本表（远程拉取）
marina remote mysql --refresh      # 强制重查索引
marina remote postgres --major 17  # 只看 17.x

marina install mysql@8.0.29        # 指定版本安装
marina install redis               # 不写版本 → TTY 里从列表选
marina start redis@7
marina exec redis@7 -- ping
marina ls
marina                             # TTY: 全屏面板（v = 版本表，可装/可切）
```

`marina` 不带参数时：TTY 进全屏面板，非 TTY（管道/CI）打印帮助，不会卡住。
面板按键：`↑↓/jk` 选择 · `enter` 操作菜单（含 Start all / Stop all / Doctor）· `s/x/r` 启停/重启 · `S/X` 全部开启/全部关闭 · `d` doctor 自检 · `v` 版本（列表来自同一个远程索引，enter 安装/激活）· `l` 日志 · `c` 配置路径 · `y` 客户端命令 · `g` 刷新 · `?` 键位 · `q` 退出；状态每 2.5s 自动刷新。
列表颜色：已下载的库名是青色，未下载的显示灰色 + `not inst.` + 黄色 `↓`；版本列表里 `◉` 绿色=已安装，`↓` 黄色=可下载。

---

## 五、命令

| 命令 | 说明 |
|---|---|
| `marina remote [db]` | 远程索引里的版本：`--refresh`、`--major M`、`--installed`、`--json` |
| `marina install <db>[@ver]` | 安装；不写版本时在 TTY 里选择。`--port`、`--force`、`--file`、`--version`、`--no-use` |
| `marina use <db>[@ver]` | 切换激活版本；`--restart` 顺便重启 |
| `marina use` | 读取最近的 `.marinarc` 批量应用 |
| `marina current` | 激活版本 + 项目 pin |
| `marina ls` / `status` | 已安装版本 + 运行状态 |
| `marina start / stop / restart [db[@ver]]` | `--all` 操作全部 |
| `marina logs <db[@ver]> [--lines N]` | 日志尾部 |
| `marina config <db[@ver]>` | 配置路径 |
| `marina port <db[@ver]> [N]` | 读/改端口（改完用 `reconfig` + `restart` 生效） |
| `marina reconfig [db[@ver]\|--all]` | 重写配置与 `current` 软链（迁移目录/改端口后用） |
| `marina rm <db[@ver]> [--purge]` | 卸载；`--purge` 连 datadir 一起删 |
| `marina exec <db[@ver]> -- <args>` | 用该版本客户端执行（自动带上 socket/port） |
| `marina which <bin>` | 解析客户端二进制 |
| `marina shims` / `marina shellenv` | 生成 PATH shims / 打印环境变量 |
| `marina doctor` | 环境自检（含索引缓存状态） |
| `marina menu` | 交互菜单 |

### 项目锁版本（`.marinarc`）

```json
{ "mysql": "8.4", "redis": "7" }
```

```bash
cd my-project && marina use      # mysql -> 8.4.11, redis -> 7.4.11
marina current                   # 显示 project pin
```

### shims

```bash
eval "$(marina shellenv)"           # export PATH="$MARINA_HOME/shims:$PATH"
mysql -uroot -proot -e "select 1"   # 自动走当前激活版本的客户端 + 该版本的 socket/port
```

---

## 六、安装流程

```
remote index ──▶ cache/<db>/<ver>/*.tar.gz ──sha256──▶ engines/<db>/<major>/<ver>/
   （镜像/上游）                                          │
                                            current 软链 ◀┘
                                                          │
  etc/<db>/<major>/*.conf ◀── 渲染模板（已存在则不覆盖，--force 才重写）
  data/<db>/<major>/      ◀── 引擎自己的初始化（mysqld --initialize-insecure / initdb / …）
  首次启动 ─▶ 设置 root 密码 / 清匿名用户 / 删 test 库 ─▶ 停止
```

- 版本号 → `engines/<db>/<major>/<version>`；major 目录深度由 `src/catalog.js` 的 `majorDepth` 决定
  （MySQL `8.4.11→8.4`，PostgreSQL `17.11→17`，Redis `7.4.11→7`）。
- 安装成功后默认切换 active（`--no-use` 可关）。
- 离线安装：`marina install mysql@8.0.29 --file ./mysql-8.0.29-macos12-arm64.tar.gz`。
- 自建产物：`MARINA_CATALOG_FILE=manifest.json`（`scripts/make-manifest.mjs` 生成），命中
  `(engine, version, os, arch)` 时优先于镜像/上游，可用来补齐 MariaDB/Memcached 等上游缺失的平台。

---

## 七、各引擎的差异（驱动实现要点）

| 引擎 | 初始化 | 启动 | 停止 | 探活 |
|---|---|---|---|---|
| MySQL | `mysqld --initialize-insecure` | `mysqld --defaults-file`（后台） | `mysqladmin shutdown` | client ping → TCP |
| MariaDB | `scripts/mariadb-install-db` | `mariadbd --defaults-file` | `mariadb-admin shutdown` | client ping → TCP |
| PostgreSQL | `initdb -D <data> -U postgres --auth=trust` | `pg_ctl -D … -o "-p … -k run -h 127.0.0.1" -w start` | `pg_ctl -m fast -w stop` | `pg_isready` → TCP |
| MongoDB | 无需（建目录即可） | `mongod … --fork --pidfilepath` | SIGTERM | `mongosh --eval ping` → TCP |
| Redis | 无需 | `redis-server <conf>`（daemonize） | `redis-cli shutdown save` | `redis-cli ping` |
| Memcached | 无需 | `memcached -l … -p … -d -P <pid>` | SIGTERM | TCP |

二进制定位不写死路径：按 `bin/ → sbin/ → scripts/ → libexec/ → lib/` 找标记（如 `bin/mysqld`），
找不到再做 BFS —— 兼容 `8.4.11/bin/...` 与 `bin/...` 两种 tar 布局。

---

## 八、代码结构（版本索引相关）

| 文件 | 职责 |
|---|---|
| `src/catalog.js` | 引擎元数据 + 编译配方（**不含任何版本号/URL**） |
| `src/indexing.js` | 每个引擎的索引源与解析：镜像目录、MySQL tag feed、MongoDB JSON |
| `src/versions.js` | 缓存、平台过滤、版本选择、HEAD 校验、校验和 |
| `src/installer.js` | 解析目标（`--file` / overlay / 索引）→ 下载/编译/配置/初始化/激活 |
| `src/overlay.js` | 自建产物覆盖（os/arch 归一化，优先级最高） |
| `test/fixtures/*.html` | 镜像目录的离线样本；测试不联网 |

---

## 九、加一个新引擎

1. 写 `src/engines/xxx.js`：

```js
export default {
  key: 'xxx', label: 'XXX', manifestName: 'xxx',
  defaultMajor: '1.0', defaultPort: 12345,
  markers: ['bin/xxxd'], serverBin: ['xxxd'], clientBins: ['xxx-cli'], primaryClient: 'xxx-cli',
  renderConfig(ctx) { return `port ${ctx.port}\ndir ${ctx.dataDir}\n`; },
  startArgs(ctx) { return [ctx.confFile]; },
  stopCommand(ctx) { return { cmd: '...', args: [...] }; },   // 或 null → SIGTERM
  async init(ctx) {}, async probe(ctx) { return null; },      // null → 用 TCP 探活
};
```

2. 在 `src/registry.js` 注册，`CONF_NAMES` 加配置文件名。
3. 在 `src/catalog.js` 加元数据与 `majorDepth` / 平台 / 编译配方。
4. 在 `src/indexing.js` 加索引源（如果不是目录列表，就写一个 refresh 函数）。

---

## 十、注意

- 默认只监听 `127.0.0.1`，仅用于本机开发。
- 默认账号：MySQL / MariaDB `root` / `root`；PostgreSQL `postgres`（trust，无密码）；
  MongoDB / Redis / Memcached 无认证。`marina status <db>` 与面板 DETAIL 会显示账号密码。
  密码来源是 `state.json` 的 `settings.mysqlRootPassword`（首次安装时写入服务端）。
- 不做开机自启；需要的话给 `~/Library/LaunchAgents/*.plist` 配
  `ProgramArguments = [node, <abs>/bin/marina.js, start, mysql@8.4]`（用户级，无需 root）。
- 目录搬家后，生成的配置里仍是旧绝对路径：`marina reconfig --all` 重写配置和 `current` 软链。
  启动时会先检查配置里的路径，发现指向别的 marina 根目录会**立即报错**并提示 reconfig，不再等 30 秒；
  源码编译出来的二进制把绝对 prefix 编进了 install_name（PostgreSQL 尤甚），搬家后需要重装。
- 索引缓存位于 `runtime/cache/index/`，删除后下次 `marina remote` 会重新查询。
