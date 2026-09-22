# 面试准备: 网营科技 — 大数据开发

**JD来源:** 用户粘贴, 2026-08-14
**轮次:** 技术面
**语言:** 中文
**Researched:** 2026-08-14(联网搜索不可用,无外部面经来源;全部问题为 [inferred from JD])
**公司情报:** 待确认 — 公开印象中"网营科技"是杭州的品牌电商服务商(代运营/TP),但未经本次核验。若属实,你的威圣/朴家电商数据经验(淘宝/抖音/快手订单、金蝶/聚水潭打通)是**直接加分项**,面试中主动建立连接。面试时确认:主营业务、数据团队规模(<50 人初创是你的 deal-breaker)、base 城市。

---

## 〇、匹配度速览(JD ↔ 你的 CV)

| JD 要求 | 你的证据 | 匹配 |
|---|---|---|
| ODS/DWD/DWS/ADS 分层建模 + ETL | mova-data 150 节点全分层(9:30 SLA)+ 奇瑞 Kimball 建模 | ✅ 强 |
| 维度建模全流程 | 奇瑞 + 无忧两段主题建模 | ✅ 强 |
| 精通 SQL + 性能优化 | Spark SQL/Hetu/Hive SQL + HikariCP 生产级排查 | ✅ 强 |
| Python/Java/Scala | Java 主栈(sync/bi 服务全栈) | ✅ 强 |
| 数据质量监控 | 每日调度巡检 + SLA 保障 + 与业务对账 | ✅ 强 |
| StarRocks/Doris/CK 至少一种 MPP | ClickHouse(无忧)+ ByteHouse — 满足"至少一种",但岗位主栈是 SR/Doris,**必被追问**,见第一章 | ⚠️ 补课 |
| OSS 存储组织/生命周期 | CV 无直接证据,Hive/MaxCompute 分区经验可迁移 | ⚠️ 补课 |
| 批量+实时同步 | 偏离线(DataWorks/XXL-Job),链路用过 Kafka | ⚠️ 话术见 3.3 |
| 面向 Agent 的 ADS / 语义层对接 | **MCP 开源 ×2(PyPI)+ 5 年指标体系建设** | ✅ 差异化王牌,见第二、四章 |

---

## 一、StarRocks/Doris 深入补充

### 1.1 架构原理

```
┌─────────────────────────────────────────────────┐
│                    FE (Frontend)                  │
│  MySQL协议解析 / 元数据管理 / 查询规划 / CBO优化器  │
│  Leader Follower Follower  (Raft一致性)            │
└──────────────────────┬──────────────────────────┘
                       │ Thrift RPC
┌──────────────────────┴──────────────────────────┐
│                    BE (Backend)                   │
│  向量化执行引擎 / 列式存储 / 数据分片(Tablet)       │
│  BE-1    BE-2    BE-3    ...    BE-N              │
└─────────────────────────────────────────────────┘
```

- **FE**: 元数据管理 + 查询解析 + 查询规划（Leader/Follower，基于 BDBJE 或 Raft）
- **BE**: 真正的数据存储和计算节点，向量化执行引擎

### 1.2 存储引擎核心：Tablet + Rowset

```
Partition (dt=2024-08-01)
  ├── Tablet 0 (hash(order_id) % 16 = 0)    → BE-1
  ├── Tablet 1 (hash(order_id) % 16 = 1)    → BE-2
  ├── Tablet 2 (hash(order_id) % 16 = 2)    → BE-3
  └── ...
```

- **Tablet**: 数据分布的最小单元，一个分区 + 一个桶 = 一个 Tablet
- **Rowset**: Tablet 内的数据版本，每次导入生成一个 Rowset
- **Compaction (合并)**: 后台将多个 Rowset 合并成一个，减少碎片、提升查询性能。Cumulative Compaction（增量合并）和 Base Compaction（基础合并）

### 1.3 索引类型

| 索引 | 说明 | 适用场景 |
|------|------|---------|
| **前缀索引** | 按排序键前 36 字节构建，默认就有 | 排序键的等值/范围查询 |
| **Bloom Filter** | 按列建，快速判断值是否存在 | 高基数列的等值过滤 |
| **Bitmap 索引** | 按列建，位图表示值存在 | 低基数列（性别、状态） |
| **倒排索引 (2.0+)** | 支持全文搜索 | 文本搜索、多条件过滤 |

```sql
-- 索引创建示例
CREATE TABLE sales (
    order_id BIGINT,
    item_id BIGINT,
    status VARCHAR(10),
    dt DATE
) PRIMARY KEY (order_id)
DISTRIBUTED BY HASH(order_id) BUCKETS 32
PROPERTIES (
    "bloom_filter_columns" = "item_id",
    "replication_num" = "3"
);

-- 对低基数列创建 Bitmap 索引
CREATE INDEX idx_status ON sales(status) USING BITMAP;
```

### 1.4 查询优化核心：CBO + 向量化执行

**CBO (Cost-Based Optimizer)**: StarRocks 的优化器比 ClickHouse 先进，支持：
- 自动 JOIN 重排（选择最优 JOIN 顺序）
- 谓词下推（Predicate Pushdown）
- 分区裁剪 + 分桶裁剪
- 物化视图自动改写

**Colocate Join (Colocation Join)** — 面试高频：
- 两个表按相同分桶键分桶，相同 hash 值的 Tablet 在同一个 BE 上
- JOIN 时**不需要跨节点 shuffle 数据**，性能提升巨大
- 前提：两个表的分桶键和桶数相同，且在同一 Colocation Group

```sql
-- Colocate Join 示例
CREATE TABLE orders (
    order_id BIGINT, customer_id BIGINT, amount DECIMAL
) PRIMARY KEY (order_id)
DISTRIBUTED BY HASH(customer_id) BUCKETS 32
PROPERTIES ("colocate_with" = "customer_group");

CREATE TABLE customers (
    customer_id BIGINT, name VARCHAR, level VARCHAR
) PRIMARY KEY (customer_id)
DISTRIBUTED BY HASH(customer_id) BUCKETS 32
PROPERTIES ("colocate_with" = "customer_group");

-- JOIN 时不需要 shuffle，直接在本地完成
```

**Runtime Filter** — 动态优化：
- JOIN 时，先扫描小表（Probe 表），构建 BloomFilter
- 在扫描大表时**实时过滤**，减少大表扫描量
- 面试时说："StarRocks 的 Runtime Filter 可以在执行时动态剪枝，比静态优化器更进一步"

### 1.5 数据导入深入

| 导入方式 | 协议 | 适用 | 关键参数 |
|---------|------|------|---------|
| Stream Load | HTTP PUT | 小批量实时 | `label`(去重), `max_filter_ratio`(容错) |
| Routine Load | MySQL 提交 Kafka 消费任务 | 持续消费 | `desired_concurrent_number`, `max_error_number` |
| Broker Load | 异步 | 大数据量 | `timeout`, `max_filter_ratio` |
| Insert Into | SQL | 小批量 | 单次限制 |

**重点 — Routine Load（Kafka 消费）**:
```sql
CREATE ROUTINE LOAD example_db.routine_load_example ON sales
COLUMNS(order_id, customer_id, amount, dt),
COLUMNS TERMINATED BY ",",
WHERE amount > 0
PROPERTIES (
    "desired_concurrent_number" = "3",
    "max_batch_interval" = "20",
    "max_error_number" = "1000"
)
FROM KAFKA (
    "kafka_broker_list" = "broker1:9092,broker2:9092",
    "kafka_topic" = "sales_topic",
    "kafka_partitions" = "0,1,2",
    "property.group.id" = "starrocks_sales_consumer"
);
```

### 1.6 与 ClickHouse 的深度对比

| 方面 | StarRocks | ClickHouse | 面试话术 |
|------|-----------|-----------|---------|
| **JOIN 策略** | Shuffle/Broadcast/Colocate + CBO 自动选择 | 默认 Broadcast right table，大表 JOIN 性能差 | "StarRocks 的 CBO 和 Colocate Join 让多表关联效率远高于 ClickHouse" |
| **更新** | Primary Key 模型 merge-on-write | Mutation 异步重写整个 partition | "StarRocks 的 merge-on-write 适合维度表频繁更新的场景" |
| **高并发** | 主键模型点查 + 短路径优化 | 原生不支持，需要 Proxy 层 | "StarRocks 可以同时服务报表和 API 点查，不用额外架一层" |
| **副本** | 多副本（3 副本默认） | 多副本 | 类似 |
| **物化视图** | 多表 JOIN + 自动改写 | Projection 单表 | "StarRocks 的 MV 可以做多表预聚合，ClickHouse 的 Projection 只支持单表" |
| **外部表** | Hive/MySQL/ES/JDBC/DataLake | 丰富的表引擎 | "StarRocks 的外部表可以 federated query Hive/MySQL，做数据湖查询" |

---

## 二、面向 AI Agent 的 ADS 层架构

### 2.1 传统 ADS vs AI 导向 ADS

**传统 ADS 层**:
```
ADS 表 → BI 报表 / 数据看板 / 固定 SQL
```
- 数据消费者是人，看的是图表
- 指标口径藏在报表逻辑里，换一个问法就要重新开发

**AI 导向 ADS 层**:
```
ADS 表 → 语义层(Qdrant) → AI Agent → 自然语言回答
```
- 数据消费者是 AI Agent，需要**结构化、可检索、可组合**的指标定义
- ADS 层不仅要提供数据，还要提供**元数据**（指标定义、维度说明、计算口径）

### 2.2 架构拆解

```
┌──────────────────────────────────────────────────────────┐
│                      用户自然语言提问                       │
│            "上周华东区广告ROI是多少？和上月比怎么样？"          │
└──────────────────────┬───────────────────────────────────┘
                       │
┌──────────────────────▼───────────────────────────────────┐
│                    AI Agent (LLM)                         │
│  1. 意图识别: "查询广告ROI，按区域过滤，时间对比"              │
│  2. 实体抽取: 时间=上周, 区域=华东, 指标=ROI, 对比=上月        │
│  3. 指标匹配: 在语义层中搜索 "ROI" 的准确定义                  │
└──────────────────────┬───────────────────────────────────┘
                       │ 向量检索
┌──────────────────────▼───────────────────────────────────┐
│                语义层 (Qdrant 向量数据库)                    │
│  存储内容:                                                 │
│  - 指标定义的 embedding: "广告ROI = 广告收入/广告消耗"         │
│  - 维度定义的 embedding: "华东 = 上海+浙江+江苏+安徽"          │
│  - 业务术语的 embedding: "ROI = 投资回报率"                   │
│  - 表/字段的映射关系: "ads_ad_roi_daily.ad_roi"              │
└──────────────────────┬───────────────────────────────────┘
                       │ SQL 生成
┌──────────────────────▼───────────────────────────────────┐
│               ADS 层 (StarRocks/Doris)                     │
│  ads_ad_roi_daily         — 广告ROI日汇总                  │
│  ads_ad_roi_weekly        — 广告ROI周汇总                  │
│  ads_region_revenue       — 区域收入明细                    │
│  ads_campaign_performance — 广告计划表现                     │
└──────────────────────────────────────────────────────────┘
```

### 2.3 关键问题回答

**Q: 需要做知识库吗？**

需要，但不是传统的文档知识库。它需要的是**指标知识库**（Metric Knowledge Base），包含：
- 每个指标的业务定义、计算逻辑、数据来源、更新频率
- 每个维度的取值和含义
- 表与字段的映射关系

这些元数据会被向量化存入 Qdrant，AI Agent 通过语义搜索找到对应的指标定义，再生成 SQL 查询 ADS 层。

**Q: 需要向量数据库吗？**

是的，JD 里的 Qdrant 就是。向量数据库在这里的作用：
- 把指标定义、维度说明、业务术语向量化
- 用户自然语言 → 向量相似度搜索 → 找到最匹配的指标定义
- 不是存业务数据，而是存**数据的数据（元数据）**

**Q: 和 RAG 的关系？**

这就是一个 RAG 模式，但检索的不是文档，而是指标定义：
- **Retrieve**: 用户问题 → 向量搜索 → 找到相关指标定义
- **Augment**: 把指标定义注入 LLM prompt
- **Generate**: LLM 生成 SQL → 查询 ADS 层 → 返回结果

### 2.4 ADS 层设计要点（面向 AI）

```
ADS 层表设计原则（面向 AI）:

1. 口径清晰: 一张表只表达一个业务主题，字段名语义化
   ❌  ads_report_1, col_a, col_b
   ✅  ads_ad_roi_daily, ad_roi_rate, ad_spend_amount

2. 结构规范: 统一维度+指标模式，避免宽表
   ✅  dim1, dim2, ..., metric1, metric2, ..., dt

3. 元数据完备: 每张表配一个元数据定义
   {
     "table": "ads_ad_roi_daily",
     "description": "广告日ROI汇总",
     "metrics": [{
       "name": "ad_roi_rate",
       "definition": "广告收入 / 广告消耗 * 100%",
       "unit": "%"
     }],
     "dimensions": [{
       "name": "region",
       "values": "华东/华南/华北/西南"
     }]
   }

4. 可组合: 指标之间可以自由组合查询
   - 拆分粒度: 按最低粒度维度建表
   - 聚合交给 AI Agent 或查询引擎
```

### 2.5 你的面试加分角度

JD 特别提到 **ADS 层面向 AI Agent**，你的 MCP 开源经验是直接加分：

**话术示例**:
> "我在 mova-data 构建的 ADS 层每日 10:00 前产出，服务 3 个业务团队。但传统 ADS 只服务 BI 报表，面向 AI Agent 的 ADS 需要多做一步——把指标定义、维度和计算口径结构化，方便语义层索引。我对 MCP 协议和 AI Agent 的数据需求有直接经验，理解 Agent 怎么消费数据、怎么把自然语言翻译成结构化查询。"

---

## 三、技术面预期问题

### 3.1 数仓建模

**Q: 说说你的数仓分层经验**
> mova-data 150 节点 DataWorks，覆盖 ODS→DWD→DWS→ADS 全分层。ODS 接入 8 渠道原始数据，DWD 清洗+标准化，DWS 按业务主题轻度汇总，ADS 产出报表指标。产出 SLA 9:30 前。

**Q: 维度建模和范式建模的区别？什么时候用哪个？**
> 维度建模（Kimball）适合分析型场景，宽表+星型/雪花模型，查询快；范式建模（Inmon）适合数据一致性要求高的场景，表多但冗余少。我实操中 DWD 层用范式减少冗余，DWS/ADS 用维度建模提升查询性能。

**Q: 缓慢变化维（SCD）怎么处理？**
> Type 1 直接覆盖（不需要历史），Type 2 拉链表（保留历史），Type 3 加字段（保留上一个值）。电商场景里用户等级变化用 Type 2 拉链表，商品名称修正用 Type 1。

### 3.2 StarRocks/Doris 专项

**Q: StarRocks 的 Colocate Join 原理？**
> 两个表按相同分桶键分桶，相同 hash 的 Tablet 在同一个 BE 上，JOIN 不需要跨节点 shuffle。前提是分桶键和桶数一致，且在同一 Colocation Group。适用于高频 JOIN 的大表。

**Q: 分桶数怎么选？**
> 一般 = BE 节点数 × CPU 核数 × 2~4。桶数太少数据倾斜，桶数太多 Tablet 碎片多影响调度。实际观察数据量调整，单 Tablet 控制在 1-10GB。

**Q: 怎么排查慢查询？**
> `EXPLAIN` 看执行计划，关注是否用了分区裁剪、分桶裁剪、Colocate Join。`PROFILE` 看每个算子耗时。常见优化：加 BloomFilter、调整分桶数、建物化视图、避免全表扫描。

**Q: Routine Load 的 exactly-once 怎么保证？**
> 通过 Kafka offset 提交 + label 去重。每次导入带唯一 label，StarRocks 保证同一个 label 的导入不会重复执行。

### 3.3 数据管道

**Q: 怎么保证数据质量？**
> 在 ODS→DWD 环节做数据校验：空值检查、格式校验、主键去重。我在 mova-data 里通过 XXL-Job 的失败重试 + 告警机制保证数据时效性。DataArts 也有 DQC 规则配置。

**Q: 实时和离线怎么选？**
> 看业务需求。广告 ROI 报表 T+1 就够了（离线），但异常点击检测需要实时。我目前主要做离线数仓，实时同步用 Kafka + Routine Load 接入 StarRocks。

---

## 四、语义层 Qdrant — 面试准备

你是大数据开发岗，不是 ML 岗，面试官不会考你 Qdrant 的向量索引算法。会考的是**架构理解**——你怎么让 ADS 层的数据能被 AI Agent 消费。

### 4.1 必知的 Qdrant 基础

| 概念 | 含义 | 类比 |
|------|------|------|
| Collection | 一组向量的集合 | MySQL 的一张表 |
| Point | 一个向量 + 它的元数据(payload) | 一行记录 |
| Payload | 附在向量上的结构化数据 | 表的其他字段 |
| 向量 | 文本的语义表示(embedding) | 把一段文字变成一串数字 |

```json
// Qdrant 里一个 Point 长这样
{
  "id": 1,
  "vector": [0.12, -0.34, 0.56, ...],  // "广告ROI" 这句话的 embedding
  "payload": {
    "metric_name": "广告ROI",
    "definition": "广告收入 / 广告消耗",
    "table": "ads_ad_roi_daily",
    "column": "ad_roi_rate",
    "unit": "%",
    "dimensions": ["region", "channel", "campaign_id"]
  }
}
```

### 4.2 端到端流程（面试官最可能问的）

**"Agent 从问问题到返回结果，完整链路是什么？"**

```
Step 1: 用户输入 "上周华东区广告ROI是多少？"
Step 2: LLM 做意图识别 → 提取实体（时间=上周, 区域=华东, 指标=广告ROI）
Step 3: 把"广告ROI"转成 embedding → 去 Qdrant 做向量相似度搜索
Step 4: Qdrant 返回 top-K 匹配的指标定义（payload里有表名、字段名、计算逻辑）
Step 5: LLM 拿着指标定义 + 实体信息 → 生成 SQL
Step 6: 执行 SQL → StarRocks 返回结果
Step 7: LLM 把结果转成自然语言 → 返回给用户
```

**关键回答**：Qdrant 只做**检索**，不做计算。它找到"ROI 对应 ads_ad_roi_daily.ad_roi_rate"这件事，真正的数据查询还是在 StarRocks。

### 4.3 你作为大数据开发要关注什么

这是你的核心答题角度——**ADS 层怎么设计才能让 Qdrant 好用**：

**1. 指标定义要结构化，不能只靠表名和字段名**

```sql
-- ❌ Agent 理解不了
SELECT col_001, col_002 FROM ads_rpt_01 WHERE col_003 = '华东'

-- ✅ 字段名语义化 + 配套元数据定义
-- ads_ad_roi_daily: 广告日ROI明细
-- 字段: ad_roi_rate (广告ROI, %), ad_spend (消耗, 元), ad_revenue (收入, 元)
```

**2. 元数据注册机制**

> "ADS 层每张表上线时，同时在 Qdrant 注册指标定义。可以用一个元数据管理平台，也可以写脚本自动同步。关键是指标定义要和表结构保持同步——表结构变了，Qdrant 里的定义也要更新。"

**3. 指标口径一致性**

> "同一个指标可能在不同表里出现（日汇总表、周汇总表），Qdrant 里需要区分。我的做法是在 payload 里加 `granularity: daily/weekly/monthly` 标签，Agent 根据用户问的时间粒度自动路由到正确的表。"

### 4.4 可能的追问

**Q: Qdrant 里存了什么？大概多少数据？**

> 存的是指标元数据，不是业务数据。一张 ADS 表对应几条到几十条指标定义。一个中等规模数仓几百张 ADS 表，几千条指标定义，Qdrant 完全够用，不需要很大。

**Q: 怎么保证语义搜索准确匹配？**

> 核心是 embedding 模型选得好 + 指标定义文本写清楚。指标定义要包含业务含义、计算口径、同义词。比如"ROI"的定义里同时写"投资回报率、ROI、return on investment"，提高召回率。另外可以做用户反馈闭环——Agent 生成的 SQL 用户确认后才执行，不对的埋点反馈回来优化。

**Q: 和直接写 SQL 有什么优势？**

> 传统 BI 每个新问题都要开发人员写 SQL 或做报表，Qdrant + Agent 让业务人员用自然语言直接问，Agent 自动匹配指标生成 SQL。不是替代 SQL，是把 SQL 的生成自动化了。你的工作从"给每个问题写 SQL"变成"建好 ADS 表 + 注册好指标定义"。

**Q: 你作为数仓开发，需要维护 Qdrant 吗？**

> 不需要维护 Qdrant 本身，但需要维护**指标定义的内容**。每次新建 ADS 表或修改指标口径时，同步更新 Qdrant 里的指标定义。这可以做成自动化——表结构变更时触发一个脚本，把元数据推送到 Qdrant。

### 4.5 你的加分角度

> "我在 MCP 开源项目里做的就是让 AI 理解工具的参数和语义，跟 Qdrant 语义层让 AI 理解指标定义是同一个思路——都是把结构化语义暴露给 AI Agent。我理解 Agent 需要什么格式的元数据才能准确调用。"

---

## 五、负责人面 / HR 面问题包(技术面之后的轮次备用)

### 5.1 负责人面

**Q: 为什么离开现在的公司?为什么看这个机会?**
> 现岗位 0→1 已完成(150 节点数仓 + 8 渠道接入),希望进入数据量级更大、有架构师协同的团队,把"面向 Agent 的数据供给"做深——这是数据领域下一个确定性方向。**不贬低现公司,强调找 1→10 的战场。** 若网营确为电商服务商,补一句:"我在威圣/朴家做过淘宝/抖音/快手订单数据和金蝶/聚水潭打通,电商数据的坑我都踩过。"

**Q: 你怎么理解"Agent 对数据的需求"?**
> 王牌题。从 MCP 开源经历讲:Agent 消费数据三个痛点——语义要准(口径)、结构要稳(schema)、响应要快(性能)——正好对应 JD 三条职责。把 JD 复述成你的理解,展示你是想得最深的候选人。

**Q: 入职 90 天怎么安排?**
> 30 天:摸清数仓分层、指标口径、StarRocks 集群现状,与语义层团队对齐指标定义流程;60 天:接手核心 ADS 表,梳理 Agent 高频查询 pattern,做第一轮物化视图/分桶优化;90 天:落地 ADS-for-Agent 建模规范 + 数据质量监控看板。

**Q: 和架构师/治理团队/AI 团队协作的经历?**
> 奇瑞(产品评审原型 + 后端对接口 + 运营验结果)、无忧(各部门标签体系)、威圣(运营/采购/财务统一口径)。落点:"消除二义性"是你一贯的工作方法。

### 5.2 HR 面

- **自我介绍(60-90s):** 5 年数仓/BI → 当前独立主导 150 节点 DataWorks 数仓 + 8 渠道接入 → 数据+Java 双肩挑 → MCP 开源、懂 Agent 怎么消费数据。
- **薪资期望:** 年包 30-40 万;被压价时:"在对比的机会都在 35-40 区间,看重总包和发展空间。"
- **到岗时间:** 在职,离职流程约 1 个月。
- **地点:** 确认 base 城市(优先杭州/上海;北京/深圳需先问远程政策)。
- **必问红线:** 团队规模、是否 996/大小周。

---

## 六、故事缺口(Story Bank 当前为空)

`interview-prep/story-bank.md` 目前没有任何 STAR+R 故事,建议面试前备齐这 4 个:

| # | 故事 | 对应考点 |
|---|------|---------|
| 1 | [建模] mova-data 从 0 到 1 分层建模 + SLA 保障 | 数仓分层主力故事、"最有成就感的项目" |
| 2 | [性能] HikariCP 连接泄漏排查 → 分批规范 | 性能排查方法论、"解决过的棘手问题" |
| 3 | [协同] 威圣统一数据口径、消除二义性 | 跨部门协同、数据治理(电商口径问题尤其贴) |
| 4 | [可靠] 8 渠道历史补数机制(幂等回放) | 管道可靠性、设计题 |

---

## 七、15 分钟面试前快速回顾

**你的锚点句**: "5 年数仓全链路经验，独立主导 150 节点 DataWorks 数仓，覆盖 8 渠道数据接入 + 全分层建模 + 9:30 前产出，同时有 AI 工程化/MCP 开源经验。"

**Top 3 要记住的**:
1. StarRocks 的 Colocate Join + 主键模型 merge-on-write 是区别于 ClickHouse 的核心优势
2. 面向 AI 的 ADS = 结构化指标定义 + 向量检索元数据 + Agent 自动生成 SQL，你的 MCP 经验直接相关
3. mova-data 150 节点全分层是核心案例，每个问题都可以回到这个项目

**你的问题（反问面试官）**:

技术面:
1. "你们 ADS 层目前在 StarRocks 上大概多大体量？Agent 查询延迟要求多少？"
2. "语义层（Qdrant）的指标定义是手动维护还是自动同步的？DWS→ADS 的指标口径变更怎么同步到语义层？"
3. "数据管道接入了多少个业务系统？实时和离线的比例大概是多少？"

负责人面 / HR 面:
4. "数据团队现在多大?数仓、治理、AI 三条线的协作边界怎么划?"
5. "团队规模、工作节奏(确认非 996)、base 城市与远程政策?"