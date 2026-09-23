---
name: career-ops-cn
description: 中国 BOSS 直聘求职助手（自 pa1nrui1/career-ops-cn 迁移）：BOSS 岗位扫描、评分、打招呼、批量发送、追踪合并、公司背调、公司研究和面试准备。用户提到 BOSS直聘 / 直聘 / BOSS 扫描 / 打招呼 / 批量沟通时使用。
arguments: mode
user_invocable: true
user-invocable: true
argument-hint: "[profile | scan | score | apply | pipeline | tracker | deep | interview-prep | pdf | patterns]"
license: MIT
---

# Career-Ops CN — BOSS 直聘路由

本 skill 服务于项目 `/Volumes/project/career-ops` 中的 BOSS 直聘流程（boss-* 模块自 pa1nrui1/career-ops-cn 迁移，已适配主项目规范）。执行任何命令、读取任何项目文件前，先把工作目录设为：

```bash
cd /Volumes/project/career-ops
```

不要在 skill 目录保存简历、BOSS cookie、天眼查 Authorization、投递日志或生成文件；这些用户数据只保存在项目目录（`data/`、`output/`、`documents/` 等）。

## BOSS 通道（先读）

BOSS 直聘无公开 API。扫描/发送一律走**用户真实 Chrome + CDP**（用户 Chrome 带 9222 调试端口启动）。**禁止用 Playwright 浏览器访问 BOSS**——会触发风控。**主动搜索（默认）**：`npm run boss:extract:daily[:all]`（boss-extract-3cities.sh）由脚本经 CDP 自行逐城逐词导航到搜索页并提取，前置条件仅要求 BOSS Chrome 已启动且已登录，无需用户手动停在搜索页。手动兜底（`npm run boss:chrome:extract --append`）才要求前台停在搜索结果页。若页面被重置为 about:blank，说明风控介入——停止重试，让用户手动搜索后重新 extract。

## 默认主线

```text
确认 cv.md 与画像已对齐
→ BOSS 搜索页 extract（或 import:url 读取单条岗位完整 JD）
→ boss:score 评分（输出 opportunity_legitimacy）
→ boss:fill --prepare 排队（每日 20 家企业配额 + 30 天公司去重）
→ boss:review 展示前 20 家，等待用户明确确认
→ boss:chrome:apply --dry-run 逐岗位预览打招呼文案
→ 用户确认后 boss:chrome:apply -- --confirmed-review 真实发送
→ 追踪表 TSV 写入 + node merge-tracker.mjs 合并
→ 发送后引导：HR 要简历则定制 PDF；进面试则 interview-prep
```

## 必停检查点

- 🔴 CHECKPOINT · 发送确认：真实发送前，必须展示 `data/boss-review.md` 的前 20 家企业、岗位分数、淘汰原因和逐条打招呼文案，等待用户在对话中明确确认。`--confirmed-review` 只是脚本门槛，确认本身必须来自用户，不得代替或假定。
- 🔴 CHECKPOINT · 发送验证：点击"发送"后，必须在聊天记录中看到本岗位定制文案；未验证到文案时停止继续发送，并记录 `failed` 或 `unverified`。
- 🔴 CHECKPOINT · 简历定制：HR 要简历或用户给岗位链接时，必须先读取完整 JD；读取失败时先补 JD，不生成定制简历。
- 🔴 CHECKPOINT · 风控退避：BOSS 要求登录/安全验证或页面被重置时，不得停在登录页轮询、刷新或反复重试；改走用户手动 Chrome + 重新 extract，或剪贴板导入兜底。

## 冷启动 Gate

先运行 `npm run doctor`。主项目已完成 onboarding（cv.md 与 config/profile.yml 已对齐）。画像确认判定与 `boss-common.mjs` 的 `loadProfile` 一致：`profile.confirmed: true`，**或**主项目 schema（`candidate` + `target_roles`/`narrative`）齐全即视为已确认。画像未就绪时不评分、不发送。

如用户明确要求从简历重建中文画像，运行 `npm run china:profile -- --input cv.md`（profile.yml / modes/_profile.md 已存在时会拒绝覆盖，需 `--force`；重建会覆盖主项目画像结构，须再次向用户确认后才执行）。

## Mode Routing

| 用户输入 | Mode |
|---|---|
| 空参数 | discovery |
| `scan` / `扫描` / `扫BOSS` | scan |
| `score` / `评分` | score |
| `apply` / `打招呼` / `发送` / `批量沟通` | apply |
| `pipeline` / `auto-pipeline` | pipeline |
| `tracker` / `追踪` | tracker |
| `deep` / `公司研究` / `公司背调` / "这家公司靠不靠谱" | deep |
| `interview-prep` / `面试准备` / "面试这家公司怎么准备" | interview-prep |
| `pdf` / `简历PDF` / "HR 让我发简历" / "帮我按这个岗位改简历" | pdf |
| `patterns` / `复盘` | patterns |
| `profile` / `画像` | profile |
| "这个岗位适合我吗" / "帮我看看这个 JD" | score |

不在上表的主项目模式（cover、followup、training、project、oferta、ofertas、contacto、email 等）由 `/career-ops` 主 skill 提供，本 skill 不处理，指引过去即可。

## Context Loading

执行任何 mode 前，读取：`AGENTS.md`（项目根）、`modes/_custom.md` 的 Boss直聘 Workflow 小节、`config/profile.yml`、`docs/CHINA_BOSS.md`（参考文档）。对应脚本：

- `scan`（主动搜索，默认）：`npm run boss:extract:daily`（只跑每城主关键词）或 `npm run boss:extract:daily:all`（主+补充关键词，凑配额用）——脚本自行导航搜索页，无需用户停在搜索页；手动兜底：`npm run boss:chrome:extract -- --company-limit 30 --max-cards 120 --click-gap-ms 2200 --append`（用户已停在搜索页时，增量必须带 `--append`）
- 单条岗位：`npm run boss:import:url -- "<url>" --append`；失败时让用户复制详情页文本，`npm run boss:import:detail -- --clipboard --append`
- `score`：`npm run boss:score -- --input data/boss-candidates.json（阈值默认读 config/profile.yml boss.send_threshold，现 3.0；仅用户当次要求时才加 --threshold 覆盖）`
- 排队：`npm run boss:fill -- --input data/boss-candidates.json --prepare`
- `apply`：先 `npm run boss:chrome:apply -- --threshold 3.0 --daily-limit 60 --dry-run（阈值/城市配额默认读 profile.yml：send_threshold 3.0、daily_limit_per_city 沪/宁/锡/常 各20、杭 40（2026-09-23 用户确认杭州再补20））`，确认后再 `--confirmed-review`
- 点名单发：`npm run boss:send:one -- --key-hash <h1[,h2,...]> --dry-run`（按 boss_jobs.key_hash 直取 MySQL，支持多个，绕过配额/去重；greeted=1 拒绝重发需 --force-greeted）→ 用户确认后加 `--confirmed-review`；key_hash 用 SQL 查（city/greeted/score 组合筛选），详见 modes/_custom.md
- 合并：发送/导入批次后 `node merge-tracker.mjs`
- `deep`：读 `modes/deep.md`；天眼查优先 MCP，鉴权失败立即降级本机 `tyc-cli`；用户未授权时只用官网/新闻/BOSS JD

## Hard Gates

- 追踪表新增一律走 `batch/tracker-additions/` TSV（boss-common.mjs 已内置），状态用 canonical `Applied`；绝不直接编辑 `data/applications.md`，绝不绕过 `merge-tracker.mjs`。
- 评分必须基于完整 JD（`jd_detail.ok=true`，含职责/要求结构）；岗位标题或列表卡片文本不得作为评分依据。
- 评分必须输出机会可信度 `opportunity_legitimacy`：`Suspicious / 可疑机会` 不进入发送队列；薪资不明确或"面议"只记录不发送。
- 每个岗位的打招呼文案基于该岗位 JD 和确认版画像单独生成，不复用模板。
- 发送成功判定：填入输入框不算；必须点击底部文字按钮"发送"并验证自定义文案进入聊天记录。
- 失败/未验证不计入当日额度与 30 天公司去重；同批次停止后续发送。
- 不破解验证码、不绕过风控、不加隐身/反检测逻辑。
- 简历定制只润色真实经历（重排/强调/融入 JD 关注点），不新增不存在的经历、技能、证书、薪资、学历、时间；不写"匹配重点"式报告章节。
- 打招呼文案默认不含手机号、微信。
- 天眼查 Authorization 只写用户本机配置，不进仓库；用户拒绝时明确说明不查工商/司法数据。

## 失败模式

| 触发条件 | 一线处理 | 仍失败兜底 |
|---|---|---|
| extract 报登录/安全验证，或页面变 about:blank | 停止重试；用户手动 Chrome 搜索到列表页后重新 extract | 剪贴板/文本导入（boss:import） |
| `boss:import:url` 失败或 `jd_detail.ok=false` | 用户登录后重试 | 用户复制详情页全文 → `boss:import:detail -- --clipboard --append` |
| `--dry-run` 未生成可复核清单 | 停止真实发送，重新评分或补候选池 | 禁用 `--confirmed-review` |
| 发送后未验证到自定义文案 | 记 `failed`/`unverified`，停同批次 | 不计额度、不计 30 天去重 |
| `tyc-mcp` 鉴权失败/连续失败 | 立即降级 `tyc-cli` | 用户拒绝授权 → 只用官网/新闻/JD |
| 主项目 update-system 报 system-files-changed | 与 boss-* 模块无关（本地迁移文件，不受 update-system 管理） | 按主项目 AGENTS.md 的更新流程处理，boss 文件保持不动 |

## 反例黑名单

- 不把简历、cookie、Authorization、投递日志存进 skill 目录。
- 画像未就绪时，不扫描、评分、发送。
- 不跳过完整 JD 读取直接按标题评分/打招呼/定制简历。
- 不复用打招呼模板。
- 不把"已填入输入框"当发送成功。
- 不编造经历、技能、证书、薪资、学历、时间、离职原因、求职动机、业务案例。
- 不破解验证码、绕过风控、诱导规避平台规则。
- 公司风险不写空泛评价——列事实信号，无可靠来源时写明确否定结论（红灯/黄灯/绿灯收尾）。

## 源与更新

boss 模块来源：https://github.com/pa1nrui1/career-ops-cn （本地参考克隆：`/Volumes/project/career-ops-cn`）。同步上游更新时手动 diff 复制，必须保留本地适配：js-yaml v5 导入、TSV tracker 写入、画像门兼容主 schema、canonical 状态 `Applied`、`resolveBossSearchCity` 回退链。
