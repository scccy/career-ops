# BOSS 直聘自动化（boss/）

用**你本机真实的 Chrome** 驱动 BOSS 直聘：扫描岗位 → 完整 JD 抽取 → 评分 → 排队 → 人工复核 → 打招呼 → 写追踪表。

> **核心原则：绝不用 Playwright / 无头浏览器访问 BOSS。**
> BOSS 对自动化浏览器的识别会直接触发风控（安全验证 / 封禁）。本模块一律通过 **CDP（Chrome DevTools Protocol）** 接管你已登录的真实 Chrome——对站点而言就是"你自己在点"。
> 另外：打招呼**必须经你人工确认**才会发送，脚本永远不会自行提交。

---

## 1. 前置条件

| 依赖 | 版本 / 说明 |
|------|-------------|
| Node.js | ≥ 18 |
| MySQL | 5.7+ / 8.x；库名默认 `career_ops`（脚本自动建库建表） |
| Chrome | 任意现代版本（136+ 必须用**独立数据目录**才能开调试端口） |
| bash | **不需要**（Windows 原生可用；驱动已改为 Node 实现） |

装依赖：

```bash
npm install          # 需要 mysql2 / js-yaml / ws（Node 18 CDP WebSocket 兼容）
```

### MySQL 连接

脚本读环境变量，缺省值见下表。**若你的库密码不是代码里的默认值，必须显式设置 `MYSQL_PASSWORD`**，否则连库失败：

```bash
export MYSQL_PASSWORD='你的密码'          # Linux / macOS
$env:MYSQL_PASSWORD='你的密码'            # Windows PowerShell
```

| 变量 | 默认值 |
|------|--------|
| `MYSQL_HOST` | `127.0.0.1` |
| `MYSQL_PORT` | `3306` |
| `MYSQL_USER` | `root` |
| `MYSQL_PASSWORD` | `从 boss/.env.local 读取` |
| `MYSQL_DB` | `career_ops` |

首次运行会自动 `CREATE DATABASE IF NOT EXISTS career_ops` 并建表：

- **`boss_jobs`** — 候选岗位池（16 列）：`key_hash`(唯一) / `company` / `title` / `salary` / `city` / `url` / `greeted` / `salary_min` / `salary_max` / `score` / `status` / `scanned_at` / `raw`(JSON 完整岗位) / 时间戳；索引：`key_hash` 唯一索引 + 5 个查询索引（city+score / company / greeted / salary / scanned）
- **`boss_config`** — 单一配置行 `boss_city_control`(JSON)：评分阈值、每城配额、词表、平台日限

`data/boss-candidates.json` 降级为**写入时的备份镜像**，权威数据在 MySQL。

---

## 2. 启动 Chrome 并登录

```bash
npm run boss:chrome:start
```

脚本会带上 `--remote-debugging-port=9222` 和**显式数据目录**拉起 Chrome（跨平台自动探测 Chrome 路径）。**默认使用你系统里真实的 Chrome 配置**——脚本接管的就是你日常那个浏览器，Cookie / 登录态 / 书签完全一致；若机器上还没有 Chrome 配置，则回退到项目内独立目录。首次启动后**在该窗口手动登录 BOSS 直聘**，登录态持久保存。

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `BOSS_CDP_PORT` | `9222` | 调试端口 |
| `BOSS_CHROME_DATA_DIR` | 平台真实 Chrome 配置目录（Windows 自动转 8.3 短路径） | 想隔离就指到别的目录 |
| `BOSS_CHROME_BIN` | 自动探测 | 手动指定 Chrome 可执行文件 |

验证 CDP 是否就绪：

```bash
curl http://127.0.0.1:9222/json/version
```

> **已启动的 Chrome 不要关。** 所有命令都复用它。不需要提前打开 zhipin.com——扫描/发送流程发现没有 BOSS 标签页时会**自动新建**一个（复用已登录会话），并自行导航到目标 URL。
>
> **Chrome 调试端口的三个坑（Windows 实测 Chrome 155）：**
> 1. 不显式传 `--user-data-dir` → 调试端口**根本不开**；
> 2. 日常双击图标启动的 Chrome 会**占住端口但只回 404**（`/json/version` 404、响应无 Server 头）——看起来在监听其实不可用；
> 3. 数据目录路径**含空格**（如默认的 "User Data"）→ 端口开了也不服务，必须用 8.3 短路径（脚本已自动处理）。
>
> 所以：**让脚本统一管理 Chrome 的启动**。如果 Chrome 已经在跑但调试接口不可用，脚本会明确报错——先完全退出 Chrome（含后台进程）再跑一次即可。

---

## 3. 完整流程

```text
① 扫描（抽取）
    ↓
② 评分
    ↓
③ 排队（筛选待发池）
    ↓
④ 复核 ← 🔴 人工检查点
    ↓
⑤ 真实发送 ← 🔴 必须你确认
    ↓
⑥ 合并追踪表
```

### ① 扫描

```bash
# 全部城市，主轮（每城前 3 个关键词）
npm run boss:extract:daily

# 全部城市，主 + 补充轮（用全部关键词）
npm run boss:extract:daily:all

# 只扫一个城市（不影响其他城）
npm run boss:extract:daily -- --city 上海 --all

# 只扫指定关键词
npm run boss:extract:daily -- --city 上海 --keywords "大数据开发,数仓"

# 预演：只打印将要导航/执行的命令，不碰浏览器、不写库
npm run boss:extract:daily -- --city 上海 --all --dry-run
```

脚本会**自己导航到 BOSS 搜索页**，你不需要手动停在搜索结果页。前置条件只有一个：**Chrome 已启动且已登录**。

### ② 评分

```bash
npm run boss:score                                  # 用 profile.yml / DB 的阈值
npm run boss:score -- --threshold 3.0               # 临时覆盖阈值
npm run boss:score -- --dry-run                     # 只算不写
```

评分**必须基于完整 JD**（`jd_detail.ok=true`，含职责/要求结构）；只拿到标题或列表卡片文本的岗位会被过滤，不参与评分——这是硬性规则，防止"按标题猜分"。

评分结果回写 `boss_jobs.score`，并输出机会可信度 `opportunity_legitimacy`。

### ③ 排队

```bash
npm run boss:fill -- --prepare
```

按每日配额 + 30 天公司去重，从候选池筛出今日待发队列。

### ④ 复核（人工检查点）

```bash
npm run boss:review
```

输出 `data/boss-review.md`：前 N 家企业、分数、淘汰原因。**这一步必须你亲自看。**

### ⑤ 发送

```bash
# 先预览文案（不发送）
npm run boss:chrome:apply -- --dry-run

# 确认无误后真实发送
npm run boss:chrome:apply -- --confirmed-review
```

| 参数 | 说明 |
|------|------|
| `--threshold` | 分数阈值（默认读配置） |
| `--daily-limit` | 本轮上限 |
| `--key-hash <h1,h2>` | 点名单发（绕过配额/去重） |
| `--gap-ms` | 每次发送间隔（默认 1400ms） |
| `--force-greeted` | 允许重发已打过招呼的（默认拒绝） |
| `--dry-run` | 只预览 |

**发送成功判定：** 填入输入框**不算**成功；必须点击底部"发送"按钮，并**验证自定义文案进入聊天记录**才算。未验证到文案时按 `failed`/`unverified` 处理，同批次停止后续发送——不计额度、不计去重。

### ⑥ 合并追踪表

```bash
node merge-tracker.mjs
```

追踪表新增走 `batch/tracker-additions/` TSV + `merge-tracker.mjs`；**绝不直接编辑 `data/applications.md`**。

### 辅助命令

```bash
npm run boss:quota                              # 查看配额使用情况
node boss/boss-check-closed.mjs --city 上海      # 检查岗位是否已关闭
npm run boss:import:url -- "<url>" --append      # 手动导入单条岗位
npm run boss:import:detail -- --input <文件> --append   # 从文本文件导入 JD 全文
```

> ⚠️ `boss:import:detail -- --clipboard` 目前用 `pbpaste` 读剪贴板，**仅 macOS 可用**；Windows/Linux 请先保存为文本文件再传 `--input`。

---

## 4. 单城市扫描总数是怎么控制的

**不是"固定抓 N 条"，而是"目标 N 家不同公司"**，由 DB 配额反推：

```text
daily_limit_per_city[城市]      ← 控制台里的"每日配额"（本质是投递上限）
  × BOSS_SCAN_BUDGET_FACTOR     ← 默认 1.3（多扫 30% 留过滤损耗）
  ÷ 该城生效词数
= 每词 company-limit
```

以「上海、配额 60、7 个词」为例：

```text
60 × 1.3 = 78（扫描预算）
78 ÷ 7   = 11（每词目标公司数）
→ --company-limit 11 --max-cards 55
```

抽取器内部两道闸（谁先到谁停）：

```js
while (scanned < maxCards && seenCompanies.size < targetCompanies)
//      ↑ 点击上限          ↑ 真正目标：N 家不同公司
```

再加 `STAGNANT_LIMIT = 8`：连续 8 次滚动没有新卡片 = 列表到底，收工。

**目标 ≠ 实际入库数。** 循环里这些都会被丢弃（不计入名额）：

| 丢弃原因 | 说明 |
|----------|------|
| 已入库跳过 | `BOSS_SKIP_KNOWN` 开启时，库里已有的岗位**不点击**直接跳过 |
| 黑名单 | 命中 `外包 / 派遣 / 猎头 / 驻场 / 某XX公司 / 催收 / 电催 / 贷后 / 信用卡逾期 / 纯销售 / 电话销售 / 不缴社保 / 无社保 / 大小周` |
| JD 不完整 | < 180 字，或无「岗位职责/任职要求」结构 |
| 同公司去重 | **一家公司只留 1 条** |

> 实操提醒：外派/驻场岗位常以「某大型综合集团公司」这类脱敏公司名出现，会命中 `某XX公司` 规则被过滤。这是**预期行为**（外派岗通常虚假高薪），不是 bug。

所以外派多、重复多的关键词，实际入库可能远低于目标值。每个关键词独立计数，但入库时按 `key_hash` 在 DB 层合并。

**想调总数，改这几个地方：**

| 目标 | 方式 |
|------|------|
| 改扫描总量（推荐） | 控制台改该城**每日配额** → 自动重算 |
| 临时改系数 | `BOSS_SCAN_BUDGET_FACTOR=2.0` |
| 加/减关键词 | 改统一词表（词变多则每词分到的变少，总数不变） |
| 完全手动 | `node boss/boss-chrome-extract.mjs --company-limit 30 --max-cards 120 --append` |

---

## 5. 节奏与节流（防风控）

**推荐在控制台里调**：「每日城市操作流程控制」区有 关键词间隔 / 城市间隔 / 卡片间隔 / 预算系数 的输入框，保存后写入 DB（`boss_config`），**对下一次扫描生效**。

环境变量仍可用（适合无控制台的脚本场景；控制台启动的任务以 DB 配置为准）：

| 变量 | 默认 | 作用 |
|------|------|------|
| `BOSS_KEYWORD_GAP_SECONDS` | `300`（5 分钟） | 同一城市内，关键词之间的休息 |
| `BOSS_CITY_GAP_SECONDS` | `600`（10 分钟） | 城市之间的休息（只扫单城时不生效） |
| `BOSS_CARD_GAP_MIN_MS` / `BOSS_CARD_GAP_MAX_MS` | `3000` / `6000` | 卡片之间的随机休息 |
| `BOSS_SCAN_BUDGET_FACTOR` | `1.3` | 扫描预算系数 |
| `BOSS_SKIP_KNOWN` | 开启 | `0` 可关闭"跳过已入库岗位" |
| `BOSS_CDP_TIMEOUT` | `30000` | CDP 调用超时（ms） |

> 跑「一个城市 + 全部 7 个词」= 6 次关键词间隔 ≈ **30 分钟纯休息**，加上抽取本身约 **40–60 分钟**。这是刻意的风控成本，不要为了快而调低。

---

## 6. 控制台（图形界面）

```bash
node boss/boss-web/server.mjs          # 或设 BOSS_DASHBOARD_PORT 改端口
```

浏览器打开 **http://127.0.0.1:4173**。功能：

- **实时概览** — 候选池总数 / 已评分 / 待发 / 今日已发、每城配额与剩余
- **候选池检索** — 按城市、分数、greeted 状态筛选，查看岗位详情
- **白名单命令执行** — 一键跑扫描/评分/排队/复核/发送，实时日志、可中途终止
- **配置管理** — 评分阈值、每城配额、统一/每城词表（写回 `boss_config`）
- **每城三步流** — 扫描（抓取该城全部关键词→评分→排队）/ 发送 / 发新扫

命令走**白名单**，`send` 属危险档需前端显式二次确认。任务有超时保护（`BOSS_RUN_TIMEOUT_MS`，默认 90 分钟）。

### 6.1 后台静默运行（持久化，Windows）

控制台由**计划任务 `BossConsole`** 托管：登录自动拉起、失败自动重启（3 次/间隔 1 分钟）、全程无可见窗口、不依赖任何终端。

```powershell
# 立即启动（无窗口）
Start-ScheduledTask -TaskName 'BossConsole'

# 手动停止（只杀 4173 端口，安全）
D:\github\career-ops\boss\stop-console.cmd

# 查看运行状态
netstat -ano | findstr /c:":4173 " | findstr LISTENING

# 取消登录自启
Unregister-ScheduledTask -TaskName 'BossConsole' -Confirm:$false
```

启动链：`计划任务 → wscript（boss/start-console-hidden.vbs，窗口样式 0）→ cmd /c start-console.cmd /noopen → node boss/boss-web/server.mjs`。`start-console.cmd` 自带端口守卫：4173 已在监听就静默退出，不会重复起实例。

> **重建任务**（换机器或误删后，PowerShell 管理员不需要，普通权限即可）：
>
> ```powershell
> $action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument '"D:\github\career-ops\boss\start-console-hidden.vbs"' -WorkingDirectory 'D:\github\career-ops'
> $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
> $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
> Register-ScheduledTask -TaskName 'BossConsole' -Action $action -Trigger $trigger -Settings $settings -Force
> ```

> **坑（已修复，勿回退）**：cmd 的 `findstr /r "A B"` 中空格会把模式拆成"或"条件，端口守卫必须写 `findstr /r /c:":4173 .*LISTENING"`（`/c:` 才是一个整体正则）。`start-console.cmd` 和 `stop-console.cmd` 都依赖这一写法——写错成裸空格形式时，stop 会误杀**所有**监听端口的进程。

---

## 7. 数据与文件

| 位置 | 内容 |
|------|------|
| MySQL `career_ops.boss_jobs` | **权威**岗位池 |
| MySQL `career_ops.boss_config` | 阈值 / 配额 / 词表配置 |
| `data/boss-candidates.json` | 岗位池的 JSON 备份镜像 |
| `data/boss-queue.json` | 待发队列 |
| `data/boss-review.md` | 复核清单 |
| `data/boss-sent-log.tsv` | 打招呼发送日志（去重与配额依据） |
| `data/last-scan.txt` | 最近一次扫描起始时间（"发新扫"的范围界定） |
| `batch/tracker-additions/*.tsv` | 追踪表新增（由 `merge-tracker.mjs` 合并） |

---

## 8. 常见问题

| 现象 | 原因 / 处理 |
|------|-------------|
| `spawn /bin/bash ENOENT` | 旧版控制台硬编码 Linux 路径。已修复为跨平台（Windows 用 `cmd.exe`，Unix 用 `/bin/sh`） |
| 报「未知城市 `["上海"]`」 | `cmd.exe` 不剥离双引号，已由驱动的 `unquote()` 处理 |
| 任务秒挂、日志只有 `[spawn error]` | 检查 Node/MySQL 环境变量；先用 `npm run doctor` 自检 |
| 连库失败 | `MYSQL_PASSWORD` 未设置或与库不符 |
| 提取报登录/安全验证，或页面变 `about:blank` | **风控介入**。立即停止重试（连续重试会加重限制）；到 Chrome 窗口手动完成验证，确认能正常搜索后再跑 |
| 卡片抽取数为 0 | 页面未登录 / 被重定向到登录页；或 JD 结构变化 |
| 找不到 Chrome | 用 `BOSS_CHROME_BIN` 指定可执行文件路径 |
| 9222 在监听但 `/json/version` 返回 404 | Chrome 在跑但**没开调试接口**（日常双击启动会这样）。完全退出 Chrome 后用 `npm run boss:chrome:start` 重启 |
| 控制台任务永远 running | 用界面终止按钮；进程树会被整组杀掉（Windows 走 `taskkill /T /F`） |

自检：

```bash
npm run doctor
```

---

## 9. 边界与伦理（不可越过）

- ✅ 可以：批量**准备**（扫描、评分、排队、生成文案）
- 🔴 **不可以**：未经人工复核就真实发送。`--confirmed-review` 是脚本门槛，**确认本身必须来自人**，不得由 AI 代替或假定
- 不复用打招呼模板——每条文案基于该岗位 JD + 确认版画像单独生成
- 不虚构经历、技能、证书、薪资、学历、时间
- 不破解验证码、不绕过风控、不加隐身/反检测逻辑
- 打招呼文案默认不含手机号、微信
- 评分必须基于完整 JD；岗位标题或卡片文本不作评分依据
- 失败/未验证的发送不计入当日额度与 30 天公司去重
- 质量优先：低于阈值的岗位明确不建议投递

---

## 10. 命令速查

```bash
npm run boss:chrome:start                    # 启动 Chrome（9222）
npm run boss:extract:daily                   # 扫描（主关键词）
npm run boss:extract:daily:all               # 扫描（全部关键词）
npm run boss:extract:daily -- --city 上海 --all
npm run boss:score                           # 评分
npm run boss:fill -- --prepare               # 排队
npm run boss:review                          # 复核清单 ← 人工看
npm run boss:chrome:apply -- --dry-run       # 预览打招呼文案
npm run boss:chrome:apply -- --confirmed-review   # 真实发送 ← 人工确认
npm run boss:send:one -- --key-hash <hash> --dry-run  # 点名单发
node merge-tracker.mjs                       # 合并追踪表
node boss/boss-web/server.mjs                # 前台启动控制台 127.0.0.1:4173
Start-ScheduledTask -TaskName 'BossConsole'  # 后台静默启动（推荐，见 §6.1）
D:\github\career-ops\boss\stop-console.cmd   # 停止后台控制台
```

---

## 11. Windows 说明

本模块可在 Windows 原生运行，无需 WSL 或 bash：

- 扫描/启动 Chrome 的入口已改为 **Node 实现**（`boss-extract-driver.mjs` / `boss-chrome-start.mjs`），三平台一致
- `.sh` 脚本保留给 Unix 用户；Windows 不需要
- 控制台的任务启动/终止按平台自适应（`cmd.exe` + `taskkill /T /F` vs `/bin/sh` + 进程组信号）
- PATH 用 `path.delimiter` 拼接（Windows `;`），不再硬编码 `:`

> 注意：部分 Node 版本在受限沙箱下可能报 `WebAssembly.instantiate(): Out of memory`，换用常规安装的 Node 即可。
