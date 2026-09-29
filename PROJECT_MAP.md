# 项目脚本索引（PROJECT_MAP）

> 根目录 156 个 .mjs 按用途索引。文件位置保持扁平（上游架构约定，doctor/test-all 按路径自检），**找文件看这里，不要挪文件**。


## 🚀 BOSS 投递流水线（日常高频）

- `boss-web/server.mjs`
- `boss-web/index.html`
- `boss-common.mjs`
- `boss-config-db.mjs`
- `boss-cdp.mjs`
- `boss-extract-3cities.sh`
- `boss-chrome-extract.mjs`
- `boss-chrome-apply.mjs`
- `boss-check-closed.mjs`
- `boss-score.mjs`
- `boss-fill.mjs`
- `boss-review.mjs`
- `boss-apply.mjs`
- `boss-scan.mjs`
- `boss-quota.mjs`
- `boss-filter-queue.mjs`
- `boss-import-url.mjs`
- `boss-import-detail.mjs`
- `boss-import-text.mjs`

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
- `china-profile.mjs`
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
共 159 条 = 156 个根目录 .mjs 全覆盖 + 3 个子目录/脚本入口（boss-web/server.mjs、boss-web/index.html、boss-extract-3cities.sh）
