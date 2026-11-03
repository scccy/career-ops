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
| PostgreSQL | 14+；库名默认 `career_ops`（脚本自动建库建表；本机 PG 18 已就绪） |
| Chrome | 任意现代版本（136+ 必须用**独立数据目录**才能开调试端口） |
| bash | **不需要**（Windows 原生可用；驱动已改为 Node 实现） |

装依赖：

```bash
npm install          # 需要 pg / js-yaml / ws（Node 18 CDP WebSocket 兼容）
```

### PostgreSQL 连接

BOSS 流程的数据面**全部以 PostgreSQL 为准**（2026-10 由 MySQL 迁移）。连接参数读环境变量，缺省值见下表；本地凭据放在 `boss/.env.local`（gitignored，`boss/pg-db.mjs` 会自动加载）：

| 变量 | 默认值 |
|------|--------|
| `PGHOST` | `127.0.0.1` |
| `PGPORT` | `5432` |
| `PGUSER` | `root` |
| `PGPASSWORD` | `从 boss/.env.local 读取` |
| `PGDATABASE` | `career_ops` |

首次运行会自动建库建表（见 `boss/pg-schema.mjs`）：

- **`boss_jobs`** — 候选岗位池：`key_hash`(唯一，按 `岗位名称+公司+base城市` 生成) / `company` / `title` / `salary` / `city` / `url` / `greeted` / `salary_min` / `salary_max` / `score` / `status` / `scanned_at` / `raw`(JSONB 完整岗位) / 时间戳；索引：`key_hash` 唯一索引 + 查询索引（city+score / company / greeted / salary / scanned / hr_active）
- **`boss_config`** — 单一配置行 `boss_city_control`(JSON 文本)：评分阈值、每城配额、统一/每城词表、扫描节奏、门禁开关、平台日限、跳词与排除规则
- **`boss_sent_log`** — 打招呼发送日志（原 `data/boss-sent-log.tsv`，去重与配额依据）
- **`boss_queue`** — 待发队列（原 `data/boss-queue*.json`；按 `queue_name` 区分 `all` / 城市）
- **`boss_runtime_state`** — 运行时状态（原 `data/last-scan.txt` 等）

`data/boss-candidates.json` 仍作为**写入时的备份镜像**，权威数据在 PostgreSQL。

> **配置唯一基准 = PostgreSQL**：操作配置不再有 `config/profile.yml` 副本，也不再回落 profile。
> 连库失败时脚本**直接报错**（历史事故：无数据库凭据时静默回落过期文件值，把厦门每日配额 120 写成了 20）。
> **城市清单 = `daily_limit_per_city` 的键**（配额 `0` = 只扫不发），不再单独维护城市列表，
> 所以控制台「＋ 添加城市」加完即可被全量跑（`boss-extract-driver` 不带 `--city`）覆盖。
> `config/profile.yml` 现在只保留**求职画像**（`greeting_style` / `jd_focus_terms` / `skills_core` 等），改它不影响扫描与发送参数。

> **从 MySQL 迁移**：一次性脚本 `npm run boss:migrate:pg`（迁移 `boss_jobs` / `boss_config` / 发送日志 / 队列 / last-scan，幂等，`--force` 可强制重导）。

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
npm run boss:score                                  # 用 DB（boss_config）的阈值
npm run boss:score -- --threshold 3.0               # 临时覆盖阈值
npm run boss:score -- --dry-run                     # 只算不写
```

评分**必须基于完整 JD**（`jd_detail.ok=true`，含职责/要求结构）；只拿到标题或列表卡片文本的岗位会被过滤，不参与评分——这是硬性规则，防止"按标题猜分"。

评分结果回写 `boss_jobs.score`，并输出机会可信度 `opportunity_legitimacy`。

### ②.5 LLM：一个批次 = 一次请求（匹配结构 + 招呼语一起回来）

评分阶段只跑**一轮** LLM，**点控制台「扫描」一条龙就做完了**（extract → score → fill，LLM 挂在 score 里）。
口径（2026-10-30 用户定的，替换掉早先「深解析 + 招呼语两趟」的做法）：

```
待处理岗位  ÷  每批岗位数  =  请求次数        ← 批次数由脚本算，日志直接写出来
每次请求   =  cv.md 全文 + 这一批每个岗位的 JD
返回       = 每个岗位一份 { job, match, greeting }：资历/外包/技术栈/职责/红线/匹配分 + 打招呼文案
```

**只有一个数量参数**：每批岗位数（`llm_analyze_batch_size`，默认 25）。输出预算与超时由 `autoBudgets()` 自动推算（`min(128000, N×1600)` token / `min(1800s, N×20s)`），不再让用户填第二、第三个数字。

```json
{ "analyses": [ { "id": "1",
    "job":   { "seniority", "employment_type", "is_outsourcing", "jd_completeness",
               "years_required", "education_required", "tech_stack[]", "responsibilities[]",
               "domain[]", "red_flags[{type,quote,reason}]", "risk_level" },
    "match": { "score": "1.0-5.0", "level", "matched[{jd_requirement,resume_evidence}]",
               "gaps[{requirement,severity,note}]", "why" },
    "greeting": { "text": "60-120 字", "basis[]" } } ] }
```

编号：请求里每个岗位写的是 **`boss_jobs.id`**（`loadCandidates()` 会带出 `dbId`），模型原样回填，所以日志和返回都能直接对回库里那一行；模型把 5 位 id 抄错时按**位置兜底**认领并在日志留痕，不丢岗位。每批发送前会打印一行 `82349=睿服科技 · 82350=中电金信 …` 便于对账。（不用 key_hash 当编号：64 位哈希抄错一位就等于这条白花钱。）

落库：整份存 `boss_jobs.raw.llm`（`schema_version` / `model` / `analyzed_at`），匹配分另存 `llm_score` 列（有索引），文案写 `raw.greeting` 且 `greetingSource = llm`；写库条件仍是 `WHERE key_hash = ?`（跨库/重灌数据都不影响）。模型不复述公司/岗位/城市/薪资，落库前用库里那行补齐（`withJobIdentity`）。

**实测（`cn:deepseek-v4.1-flash`，思考 token 也计入同一个 `max_tokens`）**：

| 思考档 | 每批 | 结果 | 用时 | completion（其中思考） | 花费 | 每条成本 |
|--------|-----|------|------|----------------------|------|---------|
| **关** | 10 | 10/10 ✅ | **22 s** | 5442（0） | **0.41** | **0.041** |
| low | 10 | 10/10 ✅ | 65 s | 12723（8371） | 0.83 | 0.083 |
| high | 3 | 3/3 ✅ | 31 s | 6364（4087） | 0.37 | 0.123 |
| high | 5 | 5/5 ✅ | 93 s | 19560（15761） | 1.15 | 0.230 |
| high | 10 | ✗ 整批截断 | 3 min+ | 16000 全被思考吃光，JSON 半截 | 0.97（0 条结果） | — |

> ⚠️ **思考链和「每批条数」是互相挤占的**：思考 token 算在同一个 `max_tokens` 里，`high` 约 1400–3100 token/条。所以同样是这批代码：
> - **默认（关思考）每批 10–25 条**，0.041 credit/条；
> - **想开 `high` 就把每批压到 3–5 条**（`autoBudgets` 会自动按 4000/条给预算，不用你算）；
> - `high` 单价是关思考的 3–6 倍、慢 4 倍，10 条一批必被截断——这不是网关硬顶，是思考把预算花完了。

花钱闸（都不需要额外参数）：

1. **已发送/已联系过的岗位永久跳过**——消息都发出去了，再评估没有意义；
2. **增量**：`raw.llm` 已有结果的直接跳过（`--llm-force` 才重跑）；
3. **单城扫描只评估本城**（控制台点某城市的「扫描」带 `--analyze-city`）；
4. 整批失败/模型漏项 → 对半拆重试，仍失败的单条回落模板文案（绝不留空招呼语）。

```bash
npm run boss:score -- --dry-run        # 先看「待处理 N 条 ÷ 每批 M = K 次请求」，不花钱
npm run boss:score -- --limit 10       # 只处理前 10 条（测试/补跑用；不带 limit = 全部待处理）
npm run boss:score -- --llm-force      # 重跑已有结果的岗位
npm run boss:score -- --no-llm         # 本次不调模型，全部模板
npm run boss:analyze -- --limit 5      # 独立补跑（同样按批，一个参数）
```

> **权威边界（用户 2026-10-30 确认）**：LLM 分只作参考（控制台「LLM」列，点开看理由/缺口/红线/技术栈），**发送资格仍以规则评分为准** `score` 列。同一 JD 跑两次，`seniority` / `jd_completeness` 这类字段会不一致——适合当素材，不适合当硬门禁。

配置在控制台「LLM」面板（存 PostgreSQL `boss_config`，与其它操作配置同一行）：

| 字段 | 说明 |
|------|------|
| 启用 | 不勾选 = 全程用模板，不产生任何模型调用 |
| 协议 | `chat` = `/chat/completions`（OpenAI 兼容：DeepSeek / OpenAI / Ollama `/v1` / vLLM / 各类中转）；`responses` = OpenAI Responses API；`messages` = Anthropic Messages API |
| base url | 协议根地址，**不要**带 `/chat/completions`。例：`https://api.deepseek.com`、`https://api.openai.com/v1`、`http://127.0.0.1:11434/v1`、`https://api.anthropic.com/v1` |
| 模型 | 如 `deepseek-chat`、`gpt-4o-mini`、`qwen2.5:14b` |
| API Key | 存库，页面只回显掩码 `sk-***abcd`；输入框留空 = 保持原值，清空要点「清除 key」。本地模型可留空 |
| 每批岗位数 | **唯一的数量参数**。批次数 = 待处理 ÷ 它。关思考时 10–25 条一批（≈22 s / 0.41 credit 每 10 条）；开 `high` 时压到 3–5 条 |
| 关闭思考链 | 网关扩展参数 `thinking:{type:'disabled'}`。**批量评估默认勾选**：high 的思考约 1400–3100 token/条，会把同一份输出预算吃光（见上表）；不支持的中转会 400，取消勾选即可 |
| 思考力度 | 关思考时无效；要开思考建议 `low` 并配小批次 |
| 系统提示词 | 留空 = 内置默认（禁止编造简历外的事实 / 每条 60–120 字） |

```

来源会如实记录：报告里标 `_来源：LLM（模型名）_` / `_来源：内置模板（…）_`，数据库 `boss_jobs.raw.greetingSource`（`llm_analysis` / `llm` / `template`）与 `raw.greetingError`，控制台候选池「招呼语」列区分 **深解析** / **LLM** / **模板**（悬停看文案）。

环境变量兜底（CLI 场景可免建配置，只补空字段，控制台填过的值优先）：
`BOSS_LLM_ENABLED` / `BOSS_LLM_BASE_URL` / `BOSS_LLM_MODEL` / `BOSS_LLM_API_KEY` / `BOSS_LLM_PROTOCOL`，
或通用别名 `OPENAI_BASE_URL` / `OPENAI_MODEL` / `OPENAI_API_KEY`。

> 提示词硬性禁止编造画像外的事实（公司、学历、年限、数字指标），并由 `boss-llm.mjs` 统一清洗输出（去引号/代码块/「文案：」前缀、压成一段话、限 160 字）。但这只是第一道闸：**发送前仍要人工复核文案**（见 ④ 复核）。

### ③ 排队

```bash
npm run boss:fill -- --prepare
```

按每日配额 + 30 天同岗位去重，从候选池筛出今日待发队列（同公司不同岗位互不阻拦）。

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

再加一道"到底"判定：连续 `BOSS_STAGNANT_LIMIT` 次（默认 8）滚到页底都没有新卡片 = 列表到底，收工。

还有两道**预算闸**（2026-10-15 起，见下）：单关键词最多**处理** `BOSS_MAX_DOM_CARDS`（默认 135）张卡片；连续 `BOSS_KNOWN_STREAK_LIMIT`（默认 60）张卡片都是「已入库岗位」就结束本词扫描。它们存在的理由：已入库岗位在点击前就被跳过、**不占点击额度**，所以「整页都是上几次扫过的岗位」时，`--max-cards` 点击上限和产出止损都不会触发，唯一兜底是滚到真页底——而每次扫描 BOSS 都把同一条列表从头再喂一遍，等于每个关键词都要把已知区域重走一遍。

> ⚠️ 卡片上限按**处理量**（窥视过的卡片数）计，不按 DOM 卡片数。点击一张卡片会执行 `card.scrollIntoView()`，这次滚动会触发 BOSS 自己的无限滚动再追加一批卡片——loader 停止滚动也拦不住，2026-10-15 上海扫描实测 DOM 从 135 涨到 165。按 DOM 计数封不住，按处理量计数才成立。

**卡片是按需加载的（2026-10-14 起）**，不是开局把整页一次性滚出来：

```text
先看首屏（15 张左右，不滚动）
→ 逐张窥视/点击，处理掉一张少一张
→ DOM 里待处理卡片 ≤ BOSS_CARD_BUFFER_LOW（默认 3）张：才向下滚一小段补货
→ 补到 ≥ BOSS_CARD_BUFFER_HIGH（默认 8）张、或连续滚到页底没有新卡片 → 停
```

滚动本身也不是 `scrollTo(0, scrollHeight)` 一步跳到页底，而是按视口分步滚（每步随机 55%~95% 视口高度，
步间随机停顿）。这样更接近真人边看边往下加载，也不会在几秒内堆出一串滚动请求。

**目标 ≠ 实际入库数。** 循环里这些都会被丢弃（不计入名额）：

| 丢弃原因 | 说明 |
|----------|------|
| 已入库跳过 | `BOSS_SKIP_KNOWN` 开启时，库里已有的岗位**不点击**直接跳过。比对用岗位键（岗位名称+公司+base城市）；卡片 href 缺失也不影响判定 |
| 标题排除（校招/实习） | 卡片标题命中控制台「排队·标题排除」（`title_exclude`）即**不点击、不入库**；点击后还会用详情标题复核一次。2026-10-15 起从"排队阶段才剔"提前到提取阶段 |
| 黑名单（提取跳词） | 命中即**不入库**（连详情都不读）；词表在控制台「提取跳词」里维护，默认 `外包 / 派遣 / 猎头 / 驻场 / 某XX公司 / 催收 / 电催 / 贷后 / 信用卡逾期 / 纯销售 / 电话销售 / 不缴社保 / 无社保 / 大小周` |
| JD 不完整 | < 180 字，或无「岗位职责/任职要求」结构 |
| 同公司去重 | **一家公司只留 1 条** |

> 实操提醒：外派/驻场岗位常以「某大型综合集团公司」这类脱敏公司名出现，会命中 `某XX公司` 规则被过滤。这是**预期行为**（外派岗通常虚假高薪），不是 bug。

> **校招/实习岗是两道闸（2026-10-15 起）**：① 扫描时卡片标题命中「排队·标题排除」就不点击、不入库；② 发送预检（`boss-send-eligibility.mjs`）也拦一道，覆盖存量（历史扫描、手工导入、别的路径）。改成两道的原因：这条规则原先只挂在排队阶段，而承接它的 `boss-filter-queue.mjs` **没有任何地方调用**（没有 npm script、不在扫描链条里）——等于从未生效，发送日志里 2026-09-20 ~ 10-14 实际发出过 24 条校招/实习岗。实测（真实库）：池内 70 条命中标题的岗位，现在 **0 条**进入发送候选。
>
> 顺序说明：同时命中 `manual_excluded`（人工暂缓）与标题排除时，报 `manual_excluded`——用户显式标记是更强的信号，自动规则不覆盖它。控制台列表里标题排除一条显示为「校招/实习岗（标题排除）」。

所以外派多、重复多的关键词，实际入库可能远低于目标值。每个关键词独立计数，但入库时按 `key_hash` 在 DB 层合并。`key_hash` = 岗位名称 + 公司 + base 城市：同一公司在上海、杭州发布同名岗位会分别入库；同公司同标题同城的多个 job id 视为同一岗位（合并/去重），不同标题仍是不同岗位。发送阶段的岗位去重与批次内一家公司一条也按 base 城市作用域；旧的无城市发送日志只按 unknown 城市匹配，不会再把其他城市的同名岗位误杀。

**想调总数，改这几个地方：**

| 目标 | 方式 |
|------|------|
| 改扫描总量（推荐） | 控制台改该城**每日配额** → 自动重算 |
| 临时改系数 | `BOSS_SCAN_BUDGET_FACTOR=2.0` |
| 加/减关键词 | 改统一词表（词变多则每词分到的变少，总数不变） |
| 完全手动 | `node boss/boss-chrome-extract.mjs --company-limit 30 --max-cards 120 --append` |

**跳词与排除规则（控制台可编辑，2026-10-14 起统一）**

三个阶段的规则都以 DB `boss_config` 为唯一来源，在控制台「每日城市操作流程控制」区直接编辑（实现见 `boss/skip-rules.mjs`）：

| 控制台字段 | 生效阶段 | 语义 | 默认值 |
|---|---|---|---|
| 提取跳词 | 扫描提取 | 命中卡片文本或 JD → **直接丢弃，岗位不入库**（连详情都不读） | 外包 / 派遣 / 猎头 / 驻场 / 某XX公司 / 催收 / 电催 / 贷后 / 信用卡逾期 / 纯销售 / 电话销售 / 不缴社保 / 无社保 / 大小周 |
| 评分风险词 | 评分 | 命中只作风险信号参与评分，**不影响入库** | 上面 12 个 + 外派 / 长期出差 / 单休 / 培训贷 / 逾期账款 / 销售岗 / 业绩提成 |
| 排队·标题排除 | 排队 | 标题命中 → 从发送队列剔除 | 校招 / 应届 / 实习 / 秋招 / 春招 / 毕业生 |
| 排队·公司排除 | 排队 | 公司名命中 → 从发送队列剔除 | 人力 / 代招 / FESCO / 外企德科 / 科锐国际 / 万宝盛华 / 任仕达 / 北京外企服务 |

- 提取跳词 / 标题排除 / 公司排除按**正则片段**处理，**每行一条**——所以 `某[^\n]{0,16}公司` 这类写法可用（也是不按逗号拆分的原因）；评分风险词按纯文本子串匹配，逗号或换行都行。
- **留空 = 该规则不启用**（不是「恢复默认」）：想完全不跳词就清空「提取跳词」。
- 正则非法在**保存那一步**就被拒绝并提示原因，不会等到扫描时静默失效。
- 改动分别对**下一次**扫描 / 评分 / 排队生效，正在跑的任务不受影响。
- 手动命令行跑提取时：`BOSS_SKIP_WORDS`（多项用换行或分号分隔）优先，其次读同一份 DB 配置（需要 PG 连接，与控制台一致），最后才是内置默认。

---

## 5. 节奏与节流（防风控）

**推荐在控制台里调**：「每日城市操作流程控制」区有 关键词间隔 / 城市间隔 / 卡片间隔 / 预算系数 / **单词语卡片上限** / **重复止损(张)** / JD完整性过滤 的输入框，保存后写入 DB（`boss_config`），**对下一次扫描生效**（扫描任务启动时由 `pacingEnv()` 注入子进程环境变量）。

环境变量仍可用（适合无控制台的脚本场景；控制台启动的任务以 DB 配置为准）：

| 变量 | 默认 | 作用 |
|------|------|------|
| `BOSS_KEYWORD_GAP_SECONDS` | `300`（5 分钟） | 同一城市内，关键词之间的休息 |
| `BOSS_CITY_GAP_SECONDS` | `600`（10 分钟） | 城市之间的休息（只扫单城时不生效） |
| `BOSS_CARD_GAP_MIN_MS` / `BOSS_CARD_GAP_MAX_MS` | `3000` / `6000` | 卡片之间的随机休息 |
| `BOSS_CARD_BUFFER_LOW` / `BOSS_CARD_BUFFER_HIGH` | `3` / `8` | 待处理卡片的下/上水位：不足 low 张才向下滚补货，补到 high 张即停 |
| `BOSS_SCROLL_STEP_GAP_MIN_MS` / `BOSS_SCROLL_STEP_GAP_MAX_MS` | `--click-gap-ms` 值 ~ 其 1.6 倍 | 每滚一步之间的随机停顿；显式设置可覆盖（驱动固定传 `--click-gap-ms 1800`） |
| `BOSS_STAGNANT_LIMIT` | `8` | 滚到页底连续多少次没有新卡片就判定列表到底（此后不再滚动） |
| `BOSS_MAX_DOM_CARDS` | `135` | 单关键词最多**处理**多少张卡片（含被跳过/被点击的）；处理满即收工，与页面自己追加多少卡片无关（`0` 关闭） |
| `BOSS_KNOWN_STREAK_LIMIT` | `60` | 连续这么多张卡片都是「已入库岗位」就结束本词扫描（`0` 关闭）；中间出现任何一张新卡片即清零 |
| `BOSS_LOAD_MAX_STEPS` | `60` | 单次补货最多滚动多少步（防止极端情况下无界滚动） |
| `BOSS_NO_YIELD_CLICKS` | `40` | 点击产出止损：连续这么多次点击都没带来新公司就结束本词扫描（`0` 关闭） |
| `BOSS_SKIP_WORDS` | 未设置 | 提取跳词覆盖：**换行或分号**分隔的正则片段（逗号不拆，避免拆坏 `{0,16}`）；设置后不再读 DB 跳词表 |
| `BOSS_TITLE_EXCLUDE` | 未设置 | 提取阶段标题排除覆盖：**逗号/顿号/换行**分隔（按正则片段处理）；设置后不再读 DB `title_exclude`。空 = 不按标题排除 |
| `BOSS_FORCE_FRONT` | 开启 | 每个关键词扫描前把 BOSS 标签页切到前台；**后台标签页不会触发 BOSS 的无限滚动**（实测 `document.hidden=true` 时滚到底也只有首屏 15 张，会被误判成「列表已到底」）。`0` 关闭（关闭后仅告警） |
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
- **候选池检索** — 按城市、分数、greeted 状态、HR活跃时间（刚刚/今日/本周/最近一个月内，读 `raw.$.hr_active`）筛选，查看岗位详情
- **白名单命令执行** — 一键跑扫描/评分/排队/复核/发送，实时日志、可中途终止
- **配置管理** — 评分阈值、每城配额、统一/每城词表（写回 `boss_config`）
- **LLM 招呼语** — base url / 模型 / 协议（chat·responses·messages）/ key / 温度 / 并发 / 系统提示词，带「测试连通」（发一句最小请求，不写库、不生成文案）
- **每城三步流** — 扫描（抓取该城全部关键词→评分→排队）/ 发送 / 发新扫

命令走**白名单**，`send` 属危险档需前端显式二次确认。任务有超时保护（`BOSS_RUN_TIMEOUT_MS`，默认 90 分钟）。

### 6.0 局域网访问（手机 / 另一台电脑）

控制台默认绑 `0.0.0.0`，启动日志会直接打印可用的局域网地址（例如 `http://192.168.31.149:4173`），照抄到手机浏览器即可。

```bash
# 绑定地址（默认 0.0.0.0 = 局域网可访问）
set BOSS_DASHBOARD_HOST=127.0.0.1    # 想收回本机独占时设这个
```

Windows 防火墙：**先确认再决定要不要加规则**，多数机器已经不用加——`node.exe` 常在首次运行时就生成了入站允许规则。检查当前 Wi-Fi 的网络类别，以及 `node.exe` 的规则是否覆盖该类别：

```powershell
Get-NetConnectionProfile | Select-Object InterfaceAlias,Name,NetworkCategory
Get-NetFirewallRule -DisplayName 'Node.js JavaScript Runtime' |
  Select-Object Enabled,Profile,Direction,Action
```

- `node.exe` 规则为 **Enabled / Inbound / Allow**，且 `Profile` 覆盖当前网络类别（`Public` 或 `Private`）→ **无需任何操作**（本机即此情况：WLAN 为 Public，已有 Public 档 node.exe 入站放行）。
- 不覆盖（例如网络是 `Private` 而规则只有 `Public`）→ 用**管理员** PowerShell 补一条：

```powershell
New-NetFirewallRule -DisplayName 'BOSS Console 4173' -Direction Inbound -Protocol TCP `
  -LocalPort 4173 -Action Allow -Profile Private -RemoteAddress LocalSubnet
```

> ⚠️ **控制台没有任何鉴权**（无令牌、无口令、不校验 Origin）。绑到 `0.0.0.0` 后，同网段任何设备打开页面就能执行 `/api/run` 真实发招呼、`/api/jobs/bulk` 删除岗位、`/api/quota` 改配额、`/api/llm` 改模型配置（含把 base url 指向任意地址、触发模型调用产生费用）。API Key 本身不会下发到浏览器（只回掩码），但这不构成鉴权。只在可信的家庭/办公网络里这么开；访客网络、公司共享网段、公共 Wi-Fi 不要开。这也是 `BOSS_DASHBOARD_HOST=127.0.0.1` 这个回退开关存在的原因。
>
> 执行仍全部发生在本机：扫描走本机 Chrome 的 CDP（9222），发送、PostgreSQL 读写在服务器进程里完成。局域网浏览器只是遥控器——本机关机/睡眠，控制台对外即断。

### 6.1 后台静默运行（持久化，Windows）

控制台由**两个计划任务**托管，全程无可见窗口、不依赖任何终端：

| 任务 | 触发 | 作用 |
|------|------|------|
| `BossConsole` | 登录时 | 拉起控制台 |
| `BossConsoleWatchdog` | 每 2 分钟 | 4173 没在监听就重新拉起（挂了自动恢复） |

> 为什么需要看门狗：`BossConsole` 的动作是 `wscript → cmd /c start-console.cmd`，wscript 启动子进程后**立即退出**，所以计划任务本身瞬间「成功完成」，Task Scheduler 的 `RestartCount`（失败重试 3 次）根本管不到真正在跑的 `node`。结果是 node 一旦退出（崩溃、被杀、手工关窗口），控制台就一直缺席到下次登录——2026-10-20 那次就是这样静默消失的。看门狗补上了这个缺口。

```powershell
# 立即启动（无窗口）
Start-ScheduledTask -TaskName 'BossConsole'

# 手动停止（只杀 4173 端口，安全；会留下 .stopped 标记，看门狗不会自动拉起）
D:\github\career-ops\boss\stop-console.cmd

# 查看运行状态
netstat -ano | findstr /c:":4173 " | findstr LISTENING

# 取消登录自启 + 解除看门狗
Unregister-ScheduledTask -TaskName 'BossConsole' -Confirm:$false
Unregister-ScheduledTask -TaskName 'BossConsoleWatchdog' -Confirm:$false
```

启动链：`计划任务 → wscript（boss/start-console-hidden.vbs，窗口样式 0）→ cmd /c start-console.cmd /noopen → node boss/boss-web/server.mjs`。`start-console.cmd` 自带端口守卫：4173 已在监听就静默退出，不会重复起实例。

**日志**：`start-console.cmd` 把 node 的 stdout/stderr 追加到 `boss/boss-web/console.log`（每次启动写一行 `start`、退出写一行 `exit code=...`，超过 ~5 MB 轮转为 `console.log.1`）。控制台「静默消失」时先看这个文件——它记录了退出码和最后输出的报错。

**停止语义**：`stop-console.cmd` 会写 `boss/boss-web/.stopped` 标记；看门狗看到该标记就不拉起。下次手动启动（桌面快捷方式 / `start-console.cmd`）或下次登录会清掉标记并恢复托管。也就是说：**手工停 = 停到下次启动/登录，不是停 2 分钟**。

> **重建任务**（换机器或误删后，PowerShell 管理员不需要，普通权限即可）：
>
> ```powershell
> $action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument '"D:\github\career-ops\boss\start-console-hidden.vbs"' -WorkingDirectory 'D:\github\career-ops'
> $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
> $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
> Register-ScheduledTask -TaskName 'BossConsole' -Action $action -Trigger $trigger -Settings $settings -Force
>
> # 看门狗：每 2 分钟检查端口，没在监听就用同一个隐藏启动器拉起
> $wdAction = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument '"D:\github\career-ops\boss\watchdog-console.vbs"' -WorkingDirectory 'D:\github\career-ops'
> $wdTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 2) -RepetitionDuration (New-TimeSpan -Days 3650)
> $wdSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -MultipleInstances IgnoreNew
> Register-ScheduledTask -TaskName 'BossConsoleWatchdog' -Action $wdAction -Trigger $wdTrigger -Settings $wdSettings -Force
> ```

> **坑（已修复，勿回退）**：cmd 的 `findstr /r "A B"` 中空格会把模式拆成"或"条件，端口守卫必须写 `findstr /r /c:":4173 .*LISTENING"`（`/c:` 才是一个整体正则）。`start-console.cmd` 和 `stop-console.cmd` 都依赖这一写法——写错成裸空格形式时，stop 会误杀**所有**监听端口的进程。

---

## 7. 数据与文件

| 位置 | 内容 |
|------|------|
| PostgreSQL `career_ops.boss_jobs` | **权威**岗位池 |
| PostgreSQL `career_ops.boss_config` | 阈值 / 配额 / 词表配置 |
| PostgreSQL `career_ops.boss_sent_log` | 打招呼发送日志（去重与配额依据） |
| PostgreSQL `career_ops.boss_queue` | 待发队列（按 `queue_name` 区分 `all` / 城市） |
| PostgreSQL `career_ops.boss_runtime_state` | 运行时状态（`last_scan_at` 等） |
| `data/boss-candidates.json` | 岗位池的 JSON 备份镜像 |
| `data/boss-review.md` | 复核清单 |
| `batch/tracker-additions/*.tsv` | 追踪表新增（由 `merge-tracker.mjs` 合并） |

**`boss_jobs` 的写入语义（2026-10-30 改）**：整池写入不再 `TRUNCATE`，改成 `INSERT … ON CONFLICT (key_hash) DO UPDATE`。

- 同一岗位（同一 `key_hash`）**永远命中同一行、同一个 `id`** —— 所以 LLM 批次可以直接拿 `id` 当岗位编号；
- 冲突时 `raw` 用 `旧 || 新` **合并**（扫描对象里没有 `llm`/`greeting` 键，合并才不会抹掉 LLM 结果）；
- `score` / `llm_score` 用 `COALESCE(新, 旧)`，扫描对象不带分数时不会把旧值写成 NULL；
- `greeted` / `contact_state` / `status` / `availability` / `manual_*` **保持旧值**（由发送、复核、关闭检测这些专门流程维护）；
- 代价：池子不再自动删除消失的岗位，靠 `npm run boss:check_closed`（`status='closed'`）收口；
- 注意：`ON CONFLICT` 也会消耗 identity 序列，所以 `id` 稳定但**不连续**（每次整池写约跳 2600），这是 PG 行为，无副作用。

---

## 8. 常见问题

| 现象 | 原因 / 处理 |
|------|-------------|
| `spawn /bin/bash ENOENT` | 旧版控制台硬编码 Linux 路径。已修复为跨平台（Windows 用 `cmd.exe`，Unix 用 `/bin/sh`） |
| 报「未知城市 `["上海"]`」 | `cmd.exe` 不剥离双引号，已由驱动的 `unquote()` 处理 |
| 任务秒挂、日志只有 `[spawn error]` | 检查 Node/PostgreSQL 环境变量；先用 `npm run doctor` 自检 |
| 连库失败（报 `读取 PostgreSQL 配置失败`） | `PGPASSWORD` 未设置或与库不符。注意：**不会**再回落 `config/profile.yml`，必须让库连通才能跑 |
| 提取报登录/安全验证，或页面变 `about:blank` | **风控介入**。立即停止重试（连续重试会加重限制）；到 Chrome 窗口手动完成验证，确认能正常搜索后再跑 |
| 卡片抽取数为 0 | 页面未登录 / 被重定向到登录页；或 JD 结构变化 |
| 找不到 Chrome | 用 `BOSS_CHROME_BIN` 指定可执行文件路径 |
| 9222 在监听但 `/json/version` 返回 404 | Chrome 在跑但**没开调试接口**（日常双击启动会这样）。完全退出 Chrome 后用 `npm run boss:chrome:start` 重启 |
| 控制台任务永远 running | 用界面终止按钮；进程树会被整组杀掉（Windows 走 `taskkill /T /F`） |
| 打开 4173 连不上 | 先看 `boss/boss-web/console.log` 末尾：有 `exit code=` 说明进程退出了，上面的报错就是原因；没有 `exit` 行且没监听 = 被外部杀掉的。看门狗每 2 分钟会重新拉起；如果 `boss/boss-web/.stopped` 标记还在（之前手工停止过），手动启动一次即可清掉 |

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
- 失败/未验证的发送不计入当日额度与 30 天同岗位去重
- 质量优先：低于阈值的岗位明确不建议投递

---

## 10. 命令速查

```bash
npm run boss:chrome:start                    # 启动 Chrome（9222）
npm run boss:extract:daily                   # 扫描（主关键词）
npm run boss:extract:daily:all               # 扫描（全部关键词）
npm run boss:extract:daily -- --city 上海 --all
npm run boss:score                           # 评分（+ LLM 评估：匹配结构 + 招呼语，一个批次一次请求）
npm run boss:score -- --dry-run              # 只看「待处理 ÷ 每批 = 几次请求」，不花钱
npm run boss:score -- --limit 10             # 只跑前 10 条（测试/补跑）
npm run boss:score -- --llm-force            # 重跑已有 LLM 结果的岗位
npm run boss:analyze -- --city 南京 --limit 5 # 独立补跑（同样按批）
node boss/boss-analyze.mjs --dry-run         # 只处理 1 条并打印，不写库
npm run boss:score -- --no-llm               # 评分但不调 LLM（全部模板）
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






