# 项目脚本索引（PROJECT_MAP）

> 根目录 139 个 .mjs 按用途索引。文件位置保持扁平（上游架构约定，doctor/test-all 按路径自检），**找文件看这里，不要挪文件**。唯一例外：BOSS 投递流水线已整体收入 `boss/` 子目录（2026-09-29 用户确认与上游根目录分离），全部脚本路径带 `boss/` 前缀，数据仍在 `data/boss-*`、配置仍在 `config/profile.yml`（以仓库根为 CWD）。


## 🚀 BOSS 投递流水线（日常高频，位于 boss/ 子目录）

- `boss/boss-web/server.mjs` — 操作控制台（http://127.0.0.1:4173）。**不要前台裸跑**：进程会把 `__dirname` 固化，脚本搬家后旧进程仍读旧路径而报 ENOENT。已注册 systemd 用户服务 `boss-web.service`（WorkingDirectory=仓库根、`Restart=always`、已 enable + linger 开机自启）：`systemctl --user {start|stop|restart|status} boss-web.service`，日志 `journalctl --user -u boss-web -f`（亦写 `/tmp/boss-web.log`）。改脚本后需 `systemctl --user restart boss-web.service` 才生效。
- `boss/boss-web/index.html`
- `boss/boss-common.mjs`
- `boss/boss-config-db.mjs`
- `boss/boss-cdp.mjs`
- `boss/china-profile.mjs`
- `boss/boss-extract-3cities.sh`
- `boss/boss-chrome-start.sh`
- `boss/boss-chrome-extract.mjs`
- `boss/boss-chrome-apply.mjs`
- `boss/boss-check-closed.mjs`
- `boss/boss-score.mjs`
- `boss/boss-fill.mjs`
- `boss/boss-review.mjs`
- `boss/boss-apply.mjs`
- `boss/boss-scan.mjs`
- `boss/boss-quota.mjs`
- `boss/boss-filter-queue.mjs`
- `boss/boss-import-url.mjs`
- `boss/boss-import-detail.mjs`
- `boss/boss-import-text.mjs`

## 📚 追踪表（applications.md 读写/合并/校验）

- `merge-tracker.mjs`
- `tracker.mjs`
- `tracker-parse.mjs`
- `tracker-utils.mjs`
- `tracker-links.mjs`
- `tracker-sync-check.mjs`
- `tracker-columns-tests.mjs`
- `tracker-writer-lock-tests.mjs`
- `dedup-tracker.mjs`
- `normalize-statuses.mjs`
- `set-status.mjs`
- `set-status-tests.mjs`
- `reserve-report-num.mjs`
- `mark-pdf-ready.mjs`
- `sync-pdf-flags.mjs`
- `find.mjs`
- `path-resolver.mjs`
- `pipeline-lock.mjs`

## 📄 CV / 简历生成（HTML·LaTeX·PDF）

- `build-cv-html.mjs`
- `build-cv-latex.mjs`
- `cv-sections-core.mjs`
- `cv-sync-check.mjs`
- `cv-templates.mjs`
- `generate-latex.mjs`
- `generate-pdf.mjs`
- `generate-cover-letter.mjs`
- `extract-latex-content.mjs`
- `patch-latex-content.mjs`
- `img-to-pdf.mjs`
- `theme-style.mjs`
- `prepare-application.mjs`
- `application-answers.mjs`
- `application-artifacts.mjs`

## 🔍 JD 处理与岗位匹配

- `jd-capture.mjs`
- `jd-similarity.mjs`
- `jd-similarity.test.mjs`
- `jd-skill-gap.mjs`
- `fetch-jd.mjs`
- `check-jd-archive.mjs`
- `title-keywords.mjs`
- `skill-extract.mjs`
- `match-star.mjs`
- `invite-match.mjs`
- `invite-match.test.mjs`
- `role-matcher.mjs`
- `fingerprint-core.mjs`
- `url-key.mjs`
- `detect-reposts.mjs`
- `detect-reposts.test.mjs`

## 🌐 门户扫描与 ATS 发现

- `scan.mjs`
- `scan-ats-full.mjs`
- `scan-hn.mjs`
- `scan-interamt.mjs`
- `discover-ats.mjs`
- `discover-ats.test.mjs`
- `verify-ats.mjs`
- `verify-portals.mjs`
- `validate-portals.mjs`
- `audit-portals.mjs`
- `dead-boards.mjs`
- `archive-posting.mjs`
- `browser-extract.mjs`
- `linkedin-join.mjs`
- `portal-health-lock.mjs`
- `check-table-freshness.mjs`

## 💬 回复 / 跟进 / 邮件

- `reply-matcher.mjs`
- `reply-matcher.test.mjs`
- `reply-watch.mjs`
- `paste-reply.mjs`
- `paste-reply-tests.mjs`
- `followup-cadence.mjs`
- `followup-cadence.test.mjs`
- `followup-seed.mjs`
- `followup-seed-tests.mjs`
- `contacts.mjs`
- `contacts.test.mjs`
- `agent-inbox.mjs`
- `agent-inbox-tests.mjs`
- `weekly-digest.mjs`

## 🤖 AI 评估与定制（多模型）

- `openai-eval.mjs`
- `ollama-eval.mjs`
- `gemini-eval.mjs`
- `openai-tailor.mjs`
- `openrouter-runner.mjs`
- `batch-evaluate-gemini.mjs`
- `batch-tailor.mjs`
- `eval-golden.mjs`
- `calibrate.mjs`
- `classify-tier.mjs`
- `assessment-log.mjs`

## 📊 分析与统计

- `stats.mjs`
- `analyze-patterns.mjs`
- `funnel-velocity.mjs`
- `hired-share.mjs`
- `hired-wall-build.mjs`
- `outcome.mjs`
- `rejection-latency.mjs`
- `salary-gap.mjs`
- `negotiation-roi.mjs`
- `process-quality.mjs`
- `process-quality.test.mjs`
- `discard-analytics.mjs`
- `upskill.mjs`
- `rank-pipeline.mjs`
- `build-dashboard.mjs`

## 🧪 自检 / 测试 / 系统工具

- `doctor.mjs`
- `test-all.mjs`
- `test-salary-filter.mjs`
- `test-trust-validator.mjs`
- `verify-pipeline.mjs`
- `verify-cv-facts.mjs`
- `update-system.mjs`
- `plugins.mjs`
- `plugin-audit.mjs`
- `plugin-install.mjs`
- `validate-plugin-registry.mjs`
- `validate-system-paths-coverage.mjs`
- `validate-untrusted-content-coverage.mjs`
- `upgrade-tests.mjs`
- `updater-migration-tests.mjs`
- `jsonc-parse.mjs`
- `user-agent.mjs`
- `playwright.cv.config.mjs`

## 📝 其他 / 一次性工具

- `add-entry.mjs`
- `check-liveness.mjs`
- `clean-markers.mjs`
- `company-funded.mjs`
- `company-history.mjs`
- `company-history.test.mjs`
- `fix-slugs.mjs`
- `intake.mjs`
- `liveness-api.mjs`
- `liveness-browser.mjs`
- `liveness-core.mjs`
- `manifesto.mjs`
- `profile-language.mjs`
- `reconcile-pipeline.mjs`
- `seed-fixture.mjs`
- `story-provenance-check.mjs`

---
共 160 条 = 139 个根目录 .mjs + boss/ 子目录 17 个 .mjs + 4 个子目录/脚本入口（boss/boss-web/server.mjs、boss/boss-web/index.html、boss/boss-extract-3cities.sh、boss/boss-chrome-start.sh）
