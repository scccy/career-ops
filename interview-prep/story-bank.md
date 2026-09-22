# Story Bank — Master STAR+R Stories

This file accumulates your best interview stories over time. Each evaluation (Block F) adds new stories here. Instead of memorizing 100 answers, maintain 5-10 deep stories that you can bend to answer almost any behavioral question.

## How it works

1. Every time `/career-ops oferta` generates Block F (Interview Plan), new STAR+R stories get appended here
2. Before your next interview, review this file — your stories are already organized by theme
3. The "Big Three" questions can be answered with stories from this bank:
   - "Tell me about yourself" → combine 2-3 stories into a narrative
   - "Tell me about your most impactful project" → pick your highest-impact story
   - "Tell me about a conflict you resolved" → find a story with a Reflection

## Stories

> 以下 4 个故事为 2026-08-14 网营科技面试前紧急起草,事实均取自 cv.md / _profile.md;
> 【】内为占位,讲之前务必在脑中补成你自己的真实细节。

### [建模] mova-data 从 0 到 1 搭建广告小游戏数据中台
**Source:** cv.md 追觅 MOVA 段(2025.10 至今)
**S (Situation):** 广告小游戏业务国内+海外并行,国内游戏、海外游戏、网文漫局 3 个业务团队都等数据用,但没有数据中台,报表靠人肉。
**T (Task):** 独立主导从 0 搭建数据中台:多渠道数据接入 + 离线数仓全分层 + BI 报表服务,并保障每日上午的产出时效。
**A (Action):**
- 8 渠道接入收敛为统一 `fetch → parse → persist` 流水线(国内:微信小游戏/巨量引擎/重力引擎/七度游戏/七麦数据;海外:Unity Ads/Google Ads/Meta Ads),新渠道接入成本变成"加一个渠道配置"
- DataWorks 离线数仓 150 个调度节点,ODS→DWD→DWS→ADS 全分层:ODS 落原始 API 数据;DWD 做字段标准化、去重、格式异常清洗;DWS 按投放/用户/收入主题汇总;ADS 直接供报表消费
- XXL-Job 每渠道独立定时拉数,渠道间故障隔离
- BI 服务:日/周/月报、收入日报明细、应用排行榜;JWT 认证 + 按角色/组织的数据权限
**R (Result):** 全链路每日 9:30 前产出、ADS 层 10:00 前,稳定服务 3 个业务团队。
**Reflection:** 【补一个真实教训,例如:某层边界没划清导致返工 / 权限模型一开始没设计的代价】
**Best for questions about:** 数仓分层、"介绍一个你从 0 到 1 的项目"、最有成就感的事、独立主导能力

### [性能] HikariCP 连接泄漏排查 → 分批提交规范
**Source:** _profile.md 工程沉淀(追觅 mova-data sync/bi 服务)
**S (Situation):** mova-data 的 Java 数据同步服务在生产环境【出现连接耗尽/响应变慢】。
**T (Task):** 定位根因并根治,且要形成规范防止复发。
**A (Action):**
- 先观测:开启 HikariCP `leak-detection-threshold=120s`,拿到连接持有超时的精确堆栈,定位到泄漏点
- 再分析:批量 upsert 长事务长时间持有连接【补上你当时的具体场景】
- 后根治:制定 BATCH_SIZE=500 分批提交规范,把规范写进项目工程文档
**R (Result):** 连接泄漏消除,同步服务恢复稳定;分批规范成为团队工程沉淀。
**Reflection:** 性能问题的方法论是"先观测、再定位、后规范"——不靠猜。这套思路同样适用于慢 SQL 排查:EXPLAIN 看计划 → profile 定位算子 → 优化并沉淀。
**Best for questions about:** "排查过最棘手的问题"、性能优化方法论、慢查询排查(可作为类比证据)

### [协同] 威圣统一电商数据口径、消除二义性
**Source:** cv.md 杭州威圣段(2023.03–2024.05)
**S (Situation):** 电商公司,订单数据散落在淘宝/抖音/快手多平台,加上金蝶(财务)、聚水潭(ERP)、本地 Excel,各部门各算各的,数据对不上、会上吵架。
**T (Task):** 统一全公司数据口径,让所有人用同一套数据说话。
**A (Action):**
- 联合运营、采购、财务逐字段确认关键字段定义与规范,统一编码体系
- 用 Spring Boot + DataX 打通四个数据源做聚合,BI 系统统一查看
- 按部门与人员职责配置数据权限
**R (Result):** 消除数据歧义,财务日/周/月报与运营报表统一口径产出。
**Reflection:** 口径统一的关键不在技术,在于拉着业务方逐字段对齐——要消除数据的二义性,先消除人的歧义。【补一个具体争执字段的例子,比如"销售额"算不算退款】
**Best for questions about:** 跨部门协同、数据治理、"和业务方意见不一致怎么办"

### [可靠] 8 渠道历史补数机制(幂等 + 回放)
**Source:** cv.md 追觅 MOVA 段
**S (Situation):** 8 个广告/游戏渠道靠 API 定时拉数,渠道数据会延迟、会修正,任务也可能失败——任何一天出错,下游报表就是错的。
**T (Task):** 设计补数机制:任意一天的数据都能被重新拉取并修正到正确状态,且重跑不产生脏数据。
**A (Action):**
- XXL-Job 每渠道独立定时任务,单渠道故障不扩散
- 补数支持指定日期范围 + 分页回放,可精确重拉任意历史区间
- 写入按(渠道 + 日期)幂等覆盖,重跑不产生重复数据
**R (Result):** 任意日期可回放自愈,渠道数据修正/任务失败都不影响最终产出,支撑 9:30 SLA。
**Reflection:** 数据管道的可靠性 = 幂等 + 可回放。设计时先假设"它一定会失败",再倒推机制。【补一个真实触发补数的事故例子更好】
**Best for questions about:** 数据管道设计、数据质量、时效性保障、"怎么保证数据准确"
