# Custom Instructions -- career-ops

<!-- ============================================================
     THIS FILE IS YOURS. It will NEVER be auto-updated.

     Put your own house rules, custom workflows, and automations
     here -- anything you want the agent to ALWAYS do (or never do).

     This is for PROCEDURAL rules ("HOW I want things done").
     For WHO you are (archetypes, narrative, comp, negotiation),
     use modes/_profile.md instead. Keeping the two separate keeps
     each one readable.

     The agent reads this file alongside the system instructions;
     your rules here take precedence over the defaults, as long as
     they don't break the Data Contract (your files are never
     touched, and we never auto-submit an application for you).

     Because this is a user-layer file, anything you write here
     survives `node update-system.mjs`. Put customizations HERE,
     not in CLAUDE.md / modes/_shared.md / other system files --
     those get overwritten on update.
     ============================================================ -->

## House Rules

<!-- Rules the agent should always follow. Examples:
     - Always write evaluation summaries in British English.
     - Never include a photo in my CV (US / ATS-first market).
     - Cap each batch run at 20 listings unless I say otherwise.
     - If a report scores below 6, skip the cover letter. -->

(none yet -- add yours above)

## Custom Workflows

<!-- Multi-step routines you run often, given a short name. Examples:
     - "weekly review": scan my saved portals, evaluate the new roles,
       then give me a one-paragraph summary of the top 3.
     - "prep <company>": pull the JD, generate STAR stories from
       article-digest.md, and draft 5 likely interview questions. -->

(none yet -- add yours above)

## Output Preferences

<!-- How you like results formatted. Examples:
     - Reports: lead with the score and the one-line verdict.
     - Show the per-step token breakdown after a batch run.
     - Save PDFs date-first: YYYY-MM-DD-company.pdf -->

(none yet -- add yours above)

## Off-Limits

<!-- Things the agent must never do for you. Examples:
     - Never auto-fill or submit an application without showing me first.
     - Never edit a system file to customize my setup -- put it here. -->

(none yet -- add yours above)

## Boss直聘 Workflow（自 career-ops-cn 迁移）

Boss直聘无公开 API。扫描/发送一律走用户真实 Chrome + AppleScript（仅 macOS + Chrome；需开启 视图→开发者→允许 Apple 事件中的 JavaScript）。不要用 Playwright 浏览器去访问 BOSS——会触发风控。

流程：`npm run boss:chrome:extract`（用户已登录并打开搜索结果页；`--append` 增量）→ `npm run boss:score`（默认阈值读 `config/profile.yml` `boss.send_threshold`，现为 3.0）→ `npm run boss:fill -- --prepare`（每日城市配额 + 30 天公司去重）→ `npm run boss:review`（必须向用户展示清单并获得明确确认）→ `npm run boss:chrome:apply --dry-run` → `npm run boss:chrome:apply -- --confirmed-review`（真实发送）。

### 日常标准（2026-09-23 用户确认）

- **评分阈值 3.0**：`config/profile.yml` `boss.send_threshold` 是唯一阈值来源，boss-score / boss-fill / boss-chrome-apply 默认全部跟随；仅当用户当次明确要求时才用 `--threshold` 临时覆盖。
- **每日标准提取关键词（`boss.daily_extract_queries`）**：每城 6 个查询——主关键词（上海×大数据开发、杭州×数仓、南京×数据开发、无锡/常州×大数据开发）+ 补充关键词（ETL / 数据工程师 / BI，用户确认均计入配额；必须用宽词 `BI` 而非 `BI开发`，否则会漏掉标题为"BI工程师"的数仓岗，如袋鼠先生）。执行方式：`bash boss-extract-3cities.sh [main|all]`——脚本是 `daily_extract_queries` 的唯一消费方，关键词改配置即生效、勿在脚本里硬编码；主关键词先跑一轮（`--company-limit 40 --max-cards 200`），`--all` 再跑补充关键词（`--company-limit 30 --max-cards 120`），每轮 `--append` 增量、轮间 `sleep 5` 降风控压力。
- **每城每日配额**：`boss.daily_limit_per_city`（2026-09-23 起五城各 20：上海/杭州/南京/无锡/常州），城市缺口按 score 降序自动补齐；补发批次前先从队列剔除 `closed`/`failed` 公司（apply 的当日去重只算 sent，不剔除会反复重选同一批死岗位）。⚠️ 配额表之外的城市不会被 apply 排除——若本次只投部分城市，必须用只含目标城市岗位的临时队列（`--input data/boss-queue-<城市>.json`），否则其他城市的岗位会混入。
- **质量红线**：标注「非开发岗，建议跳过」的岗位（产品/运营/测试/纯运维）即使凑不满配额也不发；补关键词（BI/数据工程师）只放宽岗位类型边界，不放宽跳过清单。

规则：
- 每轮发送/导入批次后运行 `node merge-tracker.mjs`——发送记录以 TSV 写入 `batch/tracker-additions/`（状态 Applied），绝不直接写 `data/applications.md`。
- 真实发送必须以用户在对话中的明确确认为准（脚本的 `--confirmed-review` 只是门槛，确认本身不能代替或假定）。
- 跳过清单（外包/派遣/猎头/驻场/催收/纯销售/无社保）与机会可信度筛选保持开启，不绕过。
- 求职画像、城市偏好读主项目 `config/profile.yml`（`location.preferred_cities` → BOSS 城市码）。
- 参考文档：docs/CHINA_BOSS.md；数据文件：data/boss-candidates.json、boss-queue.json、boss-review.md、boss-sent-log.tsv。
- 入口 skill：`/career-ops-cn`（.agents/skills/career-ops-cn/ + .claude/skills/career-ops-cn/，两份内容相同，改动时同步）。说「BOSS」、「扫直聘」、「打招呼」即触发。
- ⚠️ 每次重新运行 boss:score 都会**从全量候选池重建 boss-queue.json**——之前手动剔除的公司（校招/实习/外包/已发送）会被加回来。任何 score 重跑之后、review/send 之前，必须重新应用过滤：`!sent.has(uniqueCompanyKey(j))` + 用户排除名单（校招标识、应届、实习、人力外包代招）。发送批次因单条失败中断后，续发前也要重新过滤。
