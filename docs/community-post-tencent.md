# 我受够了每次装数据库都重来一遍，于是用 Node.js 写了一个「数据库码头」Marina（开源）

> 一句话：Marina 是一个零第三方依赖的本地数据库管理器——装版本、切版本、启停服务、改端口/账号/密码、看日志，一条命令搞定，所有东西收在一个 `runtime/` 目录里，不碰系统包管理器，也不需要 root。

适合读者：后端 / 全栈 / 独立开发者，以及想找一个「能跑起来、能改得动」的开源项目练手的同学。

---

## 一、前言：本地开发最烦的不是写代码

不知道你有没有经历过这些场面：

- 新电脑到手，`brew install mysql`，装完发现是 9.x，老项目连不上；
- 项目 A 要 MySQL 5.7，项目 B 要 8.4，两个都装，端口打架，数据目录不知道飞哪去了；
- 用 Docker 很香，但每次都要记 `-p`、`-v`、容器名，改个密码还得进容器；
- 想看日志，先 `docker ps`，再 `docker logs`，再 `docker exec`；
- 换台机器，数据库版本、端口、账号密码全部重新配一遍；
- 想装个 Redis 跑一下，结果又开了一个常驻的 Docker Desktop。

我想要的其实很简单：**像 nvm 管 Node 一样管数据库**。一条命令装版本，一条命令切版本，服务就是本机的普通进程，数据目录看得见、摸得着，删掉文件夹就等于清理干净。

找了一圈，现成的方案要么是 GUI（平台受限），要么绑定包管理器，要么必须上容器。于是干脆自己写了一个：**Marina**。

---

## 二、Marina 是什么

Marina 是一个用 Node.js 写的本地数据库管理器，支持六个引擎：

`MySQL` · `MariaDB` · `PostgreSQL` · `MongoDB` · `Redis` · `Memcached`

名字来自码头：每个数据库引擎占一个泊位，`up` 靠岸、`down` 离岸、`use` 换船（换版本）。码头有泊位号，数据库有端口号。

核心能力：

- **装版本**：`marina install mysql@8.4`，自动下载/编译、校验、解压、生成配置、初始化数据目录、完成首次启动；
- **切版本**：同一个 major 下可以装多个小版本，`marina use mysql@8.0` 立即切换；
- **管生命周期**：`start / stop / restart / status / logs`，支持一次操作多个库；
- **改配置**：端口、账号、密码都能改，MySQL 系会同步执行 `ALTER USER`；
- **项目锁版本**：项目根放一个 `.marinarc`，`marina use` 按项目切换；
- **全屏面板**：终端里直接敲 `marina`，键盘驱动，不用记命令；
- **登录自启**：macOS LaunchAgent、Linux `systemd --user`、Windows 登录计划任务；
- **完全隔离**：只监听 `127.0.0.1`，socket、pid、日志、数据全在 `runtime/` 下。

### 先看效果

```bash
marina remote                 # 六个引擎各有多少版本、最新几个、索引来源
marina remote mysql           # 某个引擎的完整版本表
marina install mysql@8.4      # 装 MySQL 8.4
marina install redis          # 不写版本 → 在终端里从列表选
marina start mysql redis      # 一次启动多个
marina exec mysql@8.4 -- -e "select version()"
marina ls
```

`marina remote` 的本机实测输出（版本号会随时间变化）：

```
DATABASE    VERSIONS  NEWEST                  INSTALLED      INDEX
MySQL       24        26.10.0, 26.7.0, 9.7.4  8.4.11         aliyun+huawei+github
MariaDB     22        13.2.1, 13.2.0, 13.1.2  11.4.13        aliyun+tencent+huawei
PostgreSQL  552       19.0, 18.7, 18.6        17.11          aliyun+tencent+huawei+upstream
MongoDB     217       9.0.8, 9.0.7, 9.0.4     7.0.45         mongodb.com
Redis       281       8.10.3, 8.10.2, 8.10.1  7.2.5, 7.4.11  huawei+upstream
Memcached   97        1.6.45, 1.6.44, 1.6.43  1.6.45         huawei
  full list: marina remote <db>   ·   refresh: marina remote --refresh
  versions are discovered remotely (mirrors first, official upstream as fallback)
```

面板大概长这样（示意）：

```
╭─ 🍊 marina 0.1.0 ──────────────────────── 3 installed · runtime/ ─╮
│ DATABASES                  │ DETAIL                               │
├────────────────────────────┴──────────────────────────────────────┤
│▸ MySQL      8.4.11   ● 3306│ MySQL 8.4.11                         │
│  MariaDB    not inst. ↓    │ state    ● running                   │
│  PostgreSQL 17.11    ○ 5432│ port     127.0.0.1:3306              │
│  MongoDB    not inst. ↓    │ account  root                        │
│  Redis      7.4.11   ○ 6379│ password root                        │
│  Memcached  not inst. ↓    │ versions 8.4.11                      │
├────────────────────────────┴──────────────────────────────────────┤
│ ↑↓ move  enter actions     │ s/x/r start/stop/restart  S/X all    │
│ · ready                    │                                      │
╰───────────────────────────────────────────────────────────────────╯
```

按键也很直白：`s/x/r` 启动/停止/重启，`S/X` 全部启停，`v` 看版本，`l` 看日志，`c` 看配置路径，`d` 跑自检，`a/A` 切登录自启。

---

## 三、为什么不用 Docker？

先说结论：**Marina 不是 Docker 的替代品，而是补一个本地开发的空位。**

| | Docker | brew / 系统包管理器 | Marina |
|---|---|---|---|
| 隔离性 | 强（容器） | 无 | 进程级，独立 runtime |
| 多版本共存 | 靠镜像/容器 | 麻烦 | 原生支持 |
| 资源开销 | 需要 daemon + 虚拟化 | 低 | 低（就是普通进程） |
| 数据可见性 | 卷/容器内 | 系统目录 | 仓库下 `runtime/`，直接 `cp` |
| 本机客户端 | 要 `docker exec` | 直接可用 | `marina exec` / shims |
| 端口/账号管理 | 手工 | 手工 | 一条命令 |
| 需要 root | 通常需要 | 通常需要 | 不需要 |

如果你要的是「和生产一致的容器环境」，Docker 仍然是对的。Marina 解决的是另一半问题：**我只是想在本机快速跑一个指定版本的数据库，用完就能停，数据还能直接备份。**

---

## 四、几个我觉得值得说的设计

### 1. 版本清单不写死在仓库里

很多版本管理器的做法是维护一份 `versions.json`，每次上游发版都要提 PR。Marina 反过来：**仓库里没有版本清单，也没有逐版本的下载地址**。

`marina remote` 运行时去查镜像/上游索引，解析后缓存 6 小时：

```
远端目录 / JSON / tag feed
        │ 解析
        ▼
版本列表 ──平台/架构过滤──▶ cache/index/*.json（TTL 6h）
        │
        ▼
install: HEAD 校验 → 下载 → 校验和 → 解压/编译
```

索引源按优先级尝试，失败自动降级。国内镜像优先，官方源兜底：

| 引擎 | 索引来源（按顺序） | 获取方式 |
|---|---|---|
| PostgreSQL | 阿里云 → 腾讯云 → 华为云 → 官方 | 目录列表 |
| Redis | 华为云 → 官方 | 目录列表 |
| MariaDB | 阿里云 → 腾讯云 → 华为云 | 目录列表 |
| MySQL | 阿里云/华为云（≤8.0）→ GitHub tag feed（8.4/9.x） | 目录 + tag feed |
| MongoDB | 官方 `full.json` → `fastdl` | JSON 索引 |
| Memcached | 华为云 → 官方 | 目录列表 |

镜像顺序可以用 `MARINA_MIRROR=huawei,aliyun` 调整，TTL 用 `MARINA_INDEX_TTL` 改，`--refresh` 强制重查。

还有一个很实际的设计：**当前平台没有产物的版本会标 `n/a`**，安装时直接告诉你原因，而不是静默装错包。

### 2. 所有状态都在一个 `runtime/` 里

```
runtime/
  engines/<db>/<major>/<version>/   下载/编译出来的 payload
  engines/<db>/<major>/current      -> 激活版本软链
  data/<db>/<major>/                datadir，升级不覆盖
  etc/<db>/<major>/                 生成的配置
  logs/<db>/<major>.log
  run/<db>-<major>.pid|.sock
  cache/                            下载缓存 + 版本索引缓存
  state.json                        激活版本、端口、设置
  state.lock                        写 state.json 的目录锁
```

好处很直接：备份就是 `cp -a runtime/data/...`，清理就是删目录，换机器把整个 `runtime/` 拷走再 `marina reconfig --all` 就能继续用。

`state.json` 的写入用了**目录锁 + 临时文件 rename 原子替换**。测试里专门起了 3 个进程并发自增，确认不会丢更新；进程崩溃留下的锁会按 pid 和锁龄自动回收。

### 3. 安装不是「解压完就算」

一次 `install` 实际做了这些事：

```
远程索引 → 下载 → 校验 → 解压/编译 → 写 marker
        → 生成配置 → 初始化 datadir → 首次启动完成 root 初始化 → 停止
```

几个容易被忽略的细节：

- **配置默认不覆盖**：`etc/` 下已有文件会保留，方便你改参数；只有 `--force` 或 `reconfig` 才重写；
- **payload 自愈**：版本目录残缺（找不到 marker）会自动删除重解压，不会留下「看起来装了其实坏了」的状态；
- **失败清理**：解压、重命名、源码编译失败会清掉本次半成品；
- **源码 vs 二进制**：PostgreSQL/Redis 本机编译，MySQL/MongoDB 用官方二进制，MariaDB/Memcached 在没有自动化构建的平台上会明确拒绝，而不是装一半。

### 4. 生命周期：不要相信 pid 文件

本地数据库最容易出的问题不是「起不来」，而是「以为起来了」和「以为停了」。

Marina 做了几件事：

- **pid 归属校验**：Linux 读 `/proc`，macOS 用 `ps`/`lsof`，Windows 读 `Win32_Process.CommandLine`。pid 被系统复用时不会误杀别的进程；
- **探活优先用引擎自带工具**（`pg_isready`、`redis-cli ping`、`mysqladmin ping`），工具坏了就回退 TCP，不会因为客户端损坏把运行中的服务判成停止；
- **启动前检查配置里的绝对路径**：仓库搬家后配置指向旧目录，会**秒级报错**并提示 `reconfig`，而不是干等 30 秒超时；
- **`status` 区分 running / degraded / stopped / port-busy**，不是简单的「有 pid 就算 running」。

最典型的一次 bug：本机另一个 `mysqld` 占了 3306，Marina 看到 pid 活着、端口也通，就报告 running；执行 stop 时差点把别人的进程杀掉。后来「运行中」被改成三个条件同时满足：**pid 文件里的进程活着 + 命令行确实属于这次安装 + 引擎协议有应答**。这也是为什么项目里有一堆看起来「过度防御」的测试。

### 5. 跨平台不是满地 `if (win32)`

引擎和生命周期只关心宿主能力：有没有 unix socket、能不能 fork、信号怎么发、shim 怎么写、登录自启用什么机制。这些差异收在 `src/host/` 的三个后端里（`linux` / `darwin` / `win32`），上层代码不再自己判断操作系统。

比如：

- macOS 自启用 LaunchAgent，Linux 用 `systemd --user`，Windows 用 `schtasks /SC ONLOGON`；
- Windows 的 `current` 软链失败时退回目录复制；
- 解压按 `.tar.gz` / `.tar.xz` / `.zip` 选参数，Windows 没有 bsdtar 时退回 PowerShell；
- MySQL 没有 unix socket 时，客户端和探活自动走 TCP。

---

## 五、工程化：198 个测试，零第三方依赖

Marina 只用 Node 内置模块，没有构建步骤，`npm test` 不需要先 `npm install`：

```
ℹ tests 198
ℹ pass 198
ℹ fail 0
```

测试覆盖的不是「函数能跑」，而是那些真正会咬人的地方：

- 远程索引解析（镜像 HTML、MySQL tag feed、MongoDB JSON）
- 版本排序、major 深度、平台过滤、overlay 归一化
- 配置路径过期检测（INI / YAML / redis.conf 三种指令）
- `state.json` 损坏归一化、`0600` 权限、跨进程锁
- pid 归属校验与 stop 终止确认（含 pid 复用防误杀）
- payload 复用 / 残缺自愈 / 解压与编译失败清理
- 三系统宿主纯函数：shim、Windows 命令行归属、计划任务 XML、systemd 转义
- TUI 按键、箭头导航、doctor、账号密码输入
- 各引擎 `account()` 契约

项目完全由 Node.js 实现，从 2026 年 10 月开始写，目前还很年轻。

---

## 六、现在的样子，以及不足

我不想把话说满，现状是：

| 能力 | 状态 |
|---|---|
| macOS CLI / 面板 | ✅ 本机实测 |
| macOS 上的 MySQL / MongoDB / PostgreSQL / Redis | ✅ 本机实测 |
| Linux | ⚠️ 代码就绪，未真机端到端验证 |
| Windows | ⚠️ 代码就绪，未真机端到端验证 |
| MariaDB / Memcached（macOS / Linux） | ⚠️ 可列版本，不自动编译 |
已知限制：

- MySQL 8.4+ 国内镜像缺失，版本号来自官方 tag feed，二进制走 `cdn.mysql.com`，国内下载可能慢；
- MySQL 只有官方 `.md5`（当前未消费），Redis/Memcached 上游没有 sha256，只能保证下载/解压完整；
- PostgreSQL 版本列表包含全部历史版本，建议 `--major 17` 过滤；
- 凭据以明文存在 `state.json`（`0600`），这是本机开发工具，别拿来管生产库；
- 登录自启是「用户登录后」触发，不是开机即启。

---

## 七、接下来想做的事，想找一起折腾的人

这个项目目前基本是我一个人在写。如果你也对「本地开发体验」这件事感兴趣，下面这些方向都很适合一起做（P0 最急，P2 可以慢慢来）：

**P0：真机验证**

- 在 Ubuntu / Debian / Fedora 上完整跑一遍 MySQL / MongoDB / PostgreSQL / Redis 的安装、启动、停止、重启、搬家；
- 在 Windows 11 上验证 CLI、面板、MySQL/MongoDB 安装、登录计划任务；
- 把遇到的问题变成 Issue，最好附上 `marina doctor --json` 和日志。

**P1：补齐平台缺口**

- macOS 上 MariaDB 的自动构建（cmake + boost）；
- macOS 上 Memcached 的自动构建（libevent）；
- 消费 MySQL 官方 `.md5`，补齐校验和；
- 让 PostgreSQL 的版本列表默认只显示受支持的 major。

**P1：新引擎**

架构上新增一个引擎只需要：写 `src/engines/xxx.js`、注册、加索引源、补测试。欢迎 `Valkey`、`ClickHouse`、`SQLite`、`Dragonfly` 这类引擎的 PR。

一个引擎驱动大概长这样，不需要改生命周期和 TUI：

```js
export default {
  key: 'xxx', label: 'XXX', defaultMajor: '1.0', defaultPort: 12345,
  markers: ['bin/xxxd'], serverBin: ['xxxd'], clientBins: ['xxx-cli'],
  renderConfig(ctx) { return `port ${ctx.port}\ndir ${ctx.dataDir}\n`; },
  startArgs(ctx) { return [ctx.confFile]; },
  stopCommand(ctx) { return { cmd: 'xxx-admin', args: ['shutdown'] }; },
  async init(ctx) {},
  async probe(ctx) { return null; },   // null → 回退 TCP 探活
  account(ctx) { return { user: null, password: null, mode: 'disabled' }; },
};
```

代码地图：

| 想改什么 | 从哪里开始 |
|---|---|
| 加一个数据库引擎 | `src/engines/` + `src/core/registry.js` + `src/install/catalog.js` + `src/install/indexing.js` |
| 改安装/下载/编译流程 | `src/install/installer.js`、`src/install/versions.js` |
| 改启动/停止/探活 | `src/runtime/lifecycle.js` |
| 改跨平台行为 | `src/host/`（`linux` / `darwin` / `win32`） |
| 改全屏面板 | `src/tui/` |

**P2：分发与文档**

- Homebrew tap / Scoop / AUR；
- 录屏、GIF、英文 README；
- 更完整的故障排查案例库。

**适合第一次参与的任务**

- 文档里的错别字、失效命令、截图更新；
- 为某个引擎补一条索引解析测试；
- 在 Issue 里报告你的系统上 `marina doctor` 的输出；
- 给 TUI 加一个你常用的小快捷键。

参与方式很简单：Fork → 改 → `npm test` → PR。项目零第三方依赖、无构建，改完直接跑，不需要配环境。没有 CLA，也不要求你一次做很大。不知道该从哪下手的话，在 Issue 里说一声你想做哪块，我会帮你把任务拆小。

你能得到什么：一个真实在跑、持续迭代的开源项目经历；数据库安装、进程管理和跨平台兼容这些偏底层的实战；以及一个会认真 review 的维护者。哪怕只是提一个使用反馈，也算贡献。

---

## 八、5 分钟上手

要求：Node.js ≥ 18.17；macOS 已实测，Linux/Windows 欢迎帮忙验证。

```bash
git clone https://gitee.com/zhqi9277/marina.git
cd marina

# 装到 ~/.local/bin，无需 sudo
bash scripts/install-cli.sh
exec $SHELL
marina --version

# 装第一个数据库
marina remote
marina install mysql@8.4
marina start mysql@8.4
marina exec mysql@8.4 -- -e "select version()"

# 打开面板
marina
```

如果只想临时用：

```bash
export PATH="$PWD/bin:$PATH"
marina --version
```

---

## 九、项目地址

- Gitee：<https://gitee.com/zhqi9277/marina>
- GitHub：<https://github.com/zhqi9277/marina-db>
- CNB：<https://cnb.cool/zhqi9277/marina>
- License：MIT

如果这个项目帮你省下了一次「重装数据库」的时间，欢迎点个 Star。更欢迎你带着一个 Issue、一个测试或者一个引擎 PR 一起来——**码头已经建好，泊位还空着。**

---

> （发布时填标签，不用粘贴到正文）标签建议：开源、Node.js、数据库、开发工具、Linux
