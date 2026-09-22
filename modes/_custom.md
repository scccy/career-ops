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

流程：`npm run boss:chrome:extract`（用户已登录并打开搜索结果页；`--append` 增量）→ `npm run boss:score -- --threshold 4.0` → `npm run boss:fill -- --prepare`（每日 20 家企业配额 + 30 天公司去重）→ `npm run boss:review`（必须向用户展示前 20 家清单并获得明确确认）→ `npm run boss:chrome:apply --dry-run` → `npm run boss:chrome:apply -- --confirmed-review`（真实发送）。

规则：
- 每轮发送/导入批次后运行 `node merge-tracker.mjs`——发送记录以 TSV 写入 `batch/tracker-additions/`（状态 Applied），绝不直接写 `data/applications.md`。
- 真实发送必须以用户在对话中的明确确认为准（脚本的 `--confirmed-review` 只是门槛，确认本身不能代替或假定）。
- 跳过清单（外包/派遣/猎头/驻场/催收/纯销售/无社保）与机会可信度筛选保持开启，不绕过。
- 求职画像、城市偏好读主项目 `config/profile.yml`（`location.preferred_cities` → BOSS 城市码）。
- 参考文档：docs/CHINA_BOSS.md；数据文件：data/boss-candidates.json、boss-queue.json、boss-review.md、boss-sent-log.tsv。
- 入口 skill：`/career-ops-cn`（.agents/skills/career-ops-cn/ + .claude/skills/career-ops-cn/，两份内容相同，改动时同步）。说「BOSS」、「扫直聘」、「打招呼」即触发。
- ⚠️ 每次重新运行 boss:score 都会**从全量候选池重建 boss-queue.json**——之前手动剔除的公司（校招/实习/外包/已发送）会被加回来。任何 score 重跑之后、review/send 之前，必须重新应用过滤：`!sent.has(uniqueCompanyKey(j))` + 用户排除名单（校招标识、应届、实习、人力外包代招）。发送批次因单条失败中断后，续发前也要重新过滤。
