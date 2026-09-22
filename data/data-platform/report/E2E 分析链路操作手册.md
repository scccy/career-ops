# E2E 分析链路操作手册

**环境**: 本地 docker（MySQL 8 / Redis 6 / Nacos） | **公司 ID**: `6001` | **日期**: 2026-07-28

---

## 概念

### 分析类型

| 类型 | 枚举值 | 说明 |
|------|--------|------|
| 事件分析 | `EVENT` | 指标聚合趋势分析（折线/柱状），支持多指标、分组、筛选、排序、分页 |
| 留存分析 | `RETENTION` | 用户留存率矩阵，初始事件 + 回访事件 + 周期数 |
| 漏斗分析 | `FUNNEL` | 多步骤转化漏斗，步骤序列 + 窗口时长 |
| 分布分析 | `DISTRIBUTION` | 单事件/属性的分布直方图，支持 AUTO / CUSTOM / DISCRETE 三种分桶模式 |
| 属性分析 | `ATTRIBUTE` | 事件属性汇总/透视表，支持摘要（summary）和透视（pivot）两种模式 |

### 核心字段速查

| 字段 | 说明 |
|------|------|
| `schemaVersion` | 协议版本，当前 `"1.0"` |
| `appId` | 数据源 appid（子包），如 `2077597832956723202` |
| `analysisType` | 分析类型枚举：`EVENT` / `RETENTION` / `FUNNEL` / `DISTRIBUTION` / `ATTRIBUTE` |
| `timeRange` | 时间范围，`startInclusive`（含）和 `endExclusive`（不含）均为 ISO 8601 带时区 |
| `timeGrain` | 时间粒度：`DAY` / `WEEK` / `MONTH` / `QUARTER` / `YEAR` / `MINUTE` |
| `metrics` | 指标数组，每个含 `eventCode`、`aggregation`、可选 `alias`、`field` |
| `filters` | 全局筛选器，`FilterGroup` 结构（`logic` + `conditions` + `groups`） |
| `groupBy` | 分组维度数组，每个含 `field`（FieldRef）、`mode`（GroupingMode）、`alias` |
| `sorts` | 排序数组，`field`（字段名）+ `direction`（`ASC` / `DESC`） |
| `page` | 分页，`pageNum` + `pageSize` |
| `display` | 展示配置，`chartType` + `options` |

### 测试种子数据

| 事件 | 事件属性 | 用户属性 |
|------|---------|---------|
| `app_start` | `channel`（string）、`screen_height`（number） | `channel`、`name` |
| `app_crash` | `is_new`（boolean）、`screen_height`（number） | `channel`、`name` |
| `register` | `channel`（string）、`is_new`（boolean） | `channel`、`name` |
| `activate` | `channel`（string） | `channel`、`name` |
| `purchase` | `amount`（number）、`channel`（string） | `channel`、`name` |

---

## 前置条件

### 1. 启动网关

```bash
cd /opt/project/qpointplay-data
./docker/run_deploy.sh gateway redeploy dev
```

### 2. 启动 auth 服务（30005）

```bash
cd /opt/project/qpointplay-data
mvn -Plocal -pl qpointplay-service/qpointplay-service-auth -am -DskipTests spring-boot:run
```

### 3. 启动 report 服务（30006）

```bash
cd /opt/project/qpointplay-data
mvn -Plocal -pl qpointplay-service/qpointplay-service-report -am -DskipTests spring-boot:run
```

### 4. 启动 holo 服务（Hologres 查询代理）

```bash
cd /opt/project/qpointplay-data
mvn -Plocal -pl qpointplay-service/qpointplay-service-holo -am -DskipTests spring-boot:run
```

### 5. 运行种子数据脚本

```bash
bash docs/data-platform/report/seed-analysis-events.sh
```

> 种子脚本向 `qpointplay_event_center` 注入 `app_start` / `app_crash` / `register` / `activate` / `purchase` 事件的测试数据，覆盖近 7 天，确保分析查询有数据返回。

### 6. 验证网关可达

```bash
curl -s -o /dev/null -w '%{http_code}' \
  http://localhost:30000/auth/v1/login \
  -X POST -H 'Content-Type: application/json' \
  -d '{}'
# 期望：非 000（网关可达）
```

---

## 一、登录获取 Token

**端点**: `POST /auth/v1/login`

> 公司成员走 SaaS 登录（email + password）。网关验签后注入 `X-User-*` Header 到下游服务。

```bash
# 登录获取 SaaS Token
LOGIN_RESP=$(curl -s -X POST http://localhost:30000/auth/v1/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@acme.com","password":"gJJKF5kFBlRHyqc2"}')

TOKEN=$(echo "$LOGIN_RESP" | jq -r '.data.accessToken')
echo "TOKEN=$TOKEN"
```

**预期响应**：
```json
{
  "code": 200,
  "data": {
    "accessToken": "<JWT Token>",
    "refreshToken": "<Refresh Token>",
    "expiresIn": 86400
  }
}
```

> 后续所有请求均通过网关 `http://localhost:30000`，携带 Header `Authorization: Bearer $TOKEN`。

---

## 二、事件分析（EVENT）

> 事件分析是最基础的分析类型，输出按时间粒度聚合的指标趋势。典型场景：近 7 天日活、付费金额趋势。

### 2.1 基础事件分析：单指标 + 日粒度

**端点**: `POST /report/analysis/query`

```bash
curl -s -X POST http://localhost:30000/report/analysis/query \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "schemaVersion": "1.0",
    "appId": 2077597832956723202,
    "analysisType": "EVENT",
    "timeRange": {
      "startInclusive": "2026-07-21T00:00:00+08:00",
      "endExclusive": "2026-07-28T00:00:00+08:00"
    },
    "timeGrain": "DAY",
    "metrics": [{
      "alias": "启动次数",
      "eventCode": "app_start",
      "aggregation": "COUNT"
    }]
  }' | jq .
```

**预期**：`code=200`，`data.rows` 含每日 `app_start` 事件次数，`data.columns` 元数据描述列。

---

### 2.2 多指标事件分析：COUNT + USER_COUNT + SUM

```bash
curl -s -X POST http://localhost:30000/report/analysis/query \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "schemaVersion": "1.0",
    "appId": 2077597832956723202,
    "analysisType": "EVENT",
    "timeRange": {
      "startInclusive": "2026-07-21T00:00:00+08:00",
      "endExclusive": "2026-07-28T00:00:00+08:00"
    },
    "timeGrain": "DAY",
    "metrics": [
      {"alias": "启动次数", "eventCode": "app_start", "aggregation": "COUNT"},
      {"alias": "启动用户数", "eventCode": "app_start", "aggregation": "USER_COUNT"},
      {"alias": "付费总额", "eventCode": "purchase", "field": {"scope": "EVENT_PROPERTY", "eventCode": "purchase", "code": "amount"}, "aggregation": "SUM"}
    ]
  }' | jq .
```

**预期**：`code=200`，三列指标同时返回。

---

### 2.3 筛选 + 排序 + 分页

```bash
curl -s -X POST http://localhost:30000/report/analysis/query \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "schemaVersion": "1.0",
    "appId": 2077597832956723202,
    "analysisType": "EVENT",
    "timeRange": {
      "startInclusive": "2026-07-21T00:00:00+08:00",
      "endExclusive": "2026-07-28T00:00:00+08:00"
    },
    "timeGrain": "DAY",
    "metrics": [{
      "alias": "启动次数",
      "eventCode": "app_start",
      "aggregation": "COUNT"
    }],
    "filters": {
      "logic": "AND",
      "conditions": [{
        "field": {"scope": "EVENT_PROPERTY", "eventCode": "app_start", "code": "channel"},
        "operator": "EQ",
        "value": "organic"
      }]
    },
    "groupBy": [{
      "alias": "渠道",
      "field": {"scope": "EVENT_PROPERTY", "eventCode": "app_start", "code": "channel"},
      "mode": "VALUE"
    }],
    "sorts": [{"field": "启动次数", "direction": "DESC"}],
    "page": {"pageNum": 1, "pageSize": 10},
    "display": {"chartType": "BAR"}
  }' | jq .
```

**预期**：`code=200`，按渠道分组，仅 `channel=organic`，按启动次数降序，分页 10 条，柱状图展示。

---

### 2.4 误差校验：appId 不在用户权限范围

```bash
curl -s -X POST http://localhost:30000/report/analysis/query \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "schemaVersion": "1.0",
    "appId": 9999999999999999999,
    "analysisType": "EVENT",
    "timeRange": {
      "startInclusive": "2026-07-21T00:00:00+08:00",
      "endExclusive": "2026-07-28T00:00:00+08:00"
    },
    "timeGrain": "DAY",
    "metrics": [{"eventCode": "app_start", "aggregation": "COUNT"}]
  }' | jq .
```

**预期**：`code=40310`（PERMISSION_DENIED），用户无此 appid 的访问权限。

---

### 2.5 误差校验：无效事件码

```bash
curl -s -X POST http://localhost:30000/report/analysis/query \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "schemaVersion": "1.0",
    "appId": 2077597832956723202,
    "analysisType": "EVENT",
    "timeRange": {
      "startInclusive": "2026-07-21T00:00:00+08:00",
      "endExclusive": "2026-07-28T00:00:00+08:00"
    },
    "timeGrain": "DAY",
    "metrics": [{"eventCode": "non_existent_event", "aggregation": "COUNT"}]
  }' | jq .
```

**预期**：`code=40010`（ANALYSIS_DEFINITION_INVALID），事件不存在。

---

## 三、留存分析（RETENTION）

> 留存分析计算在初始事件发生后，用户在第 N 天/周/月是否触发回访事件。典型场景：注册后 7 日留存。

### 3.1 基础留存分析

```bash
curl -s -X POST http://localhost:30000/report/analysis/query \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "schemaVersion": "1.0",
    "appId": 2077597832956723202,
    "analysisType": "RETENTION",
    "timeRange": {
      "startInclusive": "2026-07-21T00:00:00+08:00",
      "endExclusive": "2026-07-28T00:00:00+08:00"
    },
    "retention": {
      "initialEvent": {"eventCode": "register"},
      "returnEvent": {"eventCode": "app_start"},
      "periods": 7
    }
  }' | jq .
```

**预期**：`code=200`，`data.rows` 为留存矩阵（首日队列 + 第 1~7 天留存率），`display` 建议 `RETENTION_MATRIX`。

---

### 3.2 留存分析（带初始事件筛选 + 分组）

```bash
curl -s -X POST http://localhost:30000/report/analysis/query \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "schemaVersion": "1.0",
    "appId": 2077597832956723202,
    "analysisType": "RETENTION",
    "timeRange": {
      "startInclusive": "2026-07-21T00:00:00+08:00",
      "endExclusive": "2026-07-28T00:00:00+08:00"
    },
    "retention": {
      "initialEvent": {
        "eventCode": "register",
        "filters": {
          "logic": "AND",
          "conditions": [{
            "field": {"scope": "EVENT_PROPERTY", "eventCode": "register", "code": "channel"},
            "operator": "EQ",
            "value": "organic"
          }]
        }
      },
      "returnEvent": {"eventCode": "app_start"},
      "periods": 7
    },
    "groupBy": [{
      "alias": "注册渠道",
      "field": {"scope": "EVENT_PROPERTY", "eventCode": "register", "code": "channel"},
      "mode": "VALUE"
    }]
  }' | jq .
```

**预期**：`code=200`，仅 `channel=organic` 注册用户的留存，按注册渠道分组。

---

### 3.3 误差校验：periods 为 0 或负数

```bash
curl -s -X POST http://localhost:30000/report/analysis/query \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "schemaVersion": "1.0",
    "appId": 2077597832956723202,
    "analysisType": "RETENTION",
    "timeRange": {
      "startInclusive": "2026-07-21T00:00:00+08:00",
      "endExclusive": "2026-07-28T00:00:00+08:00"
    },
    "retention": {
      "initialEvent": {"eventCode": "register"},
      "returnEvent": {"eventCode": "app_start"},
      "periods": 0
    }
  }' | jq .
```

**预期**：`code=40010`（ANALYSIS_DEFINITION_INVALID），periods 必须 > 0。

---

### 3.4 误差校验：无 retention 定义块

```bash
curl -s -X POST http://localhost:30000/report/analysis/query \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "schemaVersion": "1.0",
    "appId": 2077597832956723202,
    "analysisType": "RETENTION",
    "timeRange": {
      "startInclusive": "2026-07-21T00:00:00+08:00",
      "endExclusive": "2026-07-28T00:00:00+08:00"
    },
    "metrics": [{"eventCode": "register", "aggregation": "COUNT"}]
  }' | jq .
```

**预期**：`code=40010`（ANALYSIS_DEFINITION_INVALID），RETENTION 类型必须提供 `retention` 定义块。

---

## 四、漏斗分析（FUNNEL）

> 漏斗分析按步骤序列计算各步转化率。典型场景：注册 -> 激活 -> 付费 转化漏斗。

### 4.1 基础漏斗分析

```bash
curl -s -X POST http://localhost:30000/report/analysis/query \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "schemaVersion": "1.0",
    "appId": 2077597832956723202,
    "analysisType": "FUNNEL",
    "timeRange": {
      "startInclusive": "2026-07-21T00:00:00+08:00",
      "endExclusive": "2026-07-28T00:00:00+08:00"
    },
    "funnel": {
      "steps": [
        {"eventCode": "register"},
        {"eventCode": "activate"},
        {"eventCode": "purchase"}
      ],
      "windowSeconds": 604800
    },
    "display": {"chartType": "FUNNEL"}
  }' | jq .
```

**预期**：`code=200`，`data.rows` 为各步骤人数及转化率，`windowSeconds=604800`（7 天）。

---

### 4.2 漏斗分析（带步骤筛选 + 分组）

```bash
curl -s -X POST http://localhost:30000/report/analysis/query \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "schemaVersion": "1.0",
    "appId": 2077597832956723202,
    "analysisType": "FUNNEL",
    "timeRange": {
      "startInclusive": "2026-07-21T00:00:00+08:00",
      "endExclusive": "2026-07-28T00:00:00+08:00"
    },
    "funnel": {
      "steps": [
        {
          "eventCode": "register",
          "filters": {
            "logic": "AND",
            "conditions": [{
              "field": {"scope": "EVENT_PROPERTY", "eventCode": "register", "code": "channel"},
              "operator": "EQ",
              "value": "organic"
            }]
          }
        },
        {"eventCode": "activate"},
        {"eventCode": "purchase"}
      ],
      "windowSeconds": 86400
    },
    "groupBy": [{
      "alias": "注册渠道",
      "field": {"scope": "EVENT_PROPERTY", "eventCode": "register", "code": "channel"},
      "mode": "VALUE"
    }],
    "display": {"chartType": "FUNNEL"}
  }' | jq .
```

**预期**：`code=200`，按注册渠道分组，窗口 1 天，每步含筛选。

---

### 4.3 误差校验：漏斗步骤 < 2

```bash
curl -s -X POST http://localhost:30000/report/analysis/query \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "schemaVersion": "1.0",
    "appId": 2077597832956723202,
    "analysisType": "FUNNEL",
    "timeRange": {
      "startInclusive": "2026-07-21T00:00:00+08:00",
      "endExclusive": "2026-07-28T00:00:00+08:00"
    },
    "funnel": {
      "steps": [{"eventCode": "register"}],
      "windowSeconds": 86400
    }
  }' | jq .
```

**预期**：`code=40010`（ANALYSIS_DEFINITION_INVALID），漏斗至少需要 2 个步骤。

---

### 4.4 误差校验：无 funnel 定义块

```bash
curl -s -X POST http://localhost:30000/report/analysis/query \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "schemaVersion": "1.0",
    "appId": 2077597832956723202,
    "analysisType": "FUNNEL",
    "timeRange": {
      "startInclusive": "2026-07-21T00:00:00+08:00",
      "endExclusive": "2026-07-28T00:00:00+08:00"
    },
    "metrics": [{"eventCode": "register", "aggregation": "COUNT"}]
  }' | jq .
```

**预期**：`code=40010`（ANALYSIS_DEFINITION_INVALID），FUNNEL 类型必须提供 `funnel` 定义块。

---

## 五、分布分析（DISTRIBUTION）

> 分布分析统计事件发生次数或属性值的分布直方图。支持三种分桶模式：`AUTO`（自动等距）、`CUSTOM`（自定义区间）、`DISCRETE`（离散值）。

### 5.1 分布分析：AUTO 模式（自动分桶）

```bash
curl -s -X POST http://localhost:30000/report/analysis/query \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "schemaVersion": "1.0",
    "appId": 2077597832956723202,
    "analysisType": "DISTRIBUTION",
    "timeRange": {
      "startInclusive": "2026-07-21T00:00:00+08:00",
      "endExclusive": "2026-07-28T00:00:00+08:00"
    },
    "distribution": {
      "subjectType": "EVENT_COUNT",
      "eventCode": "app_start",
      "bucketMode": "AUTO"
    },
    "display": {"chartType": "HISTOGRAM"}
  }' | jq .
```

**预期**：`code=200`，`data.rows` 为自动分桶的频率分布，`data.columns` 含 `bucket` 和 `count` 列。

---

### 5.2 分布分析：CUSTOM 模式（自定义区间）

```bash
curl -s -X POST http://localhost:30000/report/analysis/query \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "schemaVersion": "1.0",
    "appId": 2077597832956723202,
    "analysisType": "DISTRIBUTION",
    "timeRange": {
      "startInclusive": "2026-07-21T00:00:00+08:00",
      "endExclusive": "2026-07-28T00:00:00+08:00"
    },
    "distribution": {
      "subjectType": "EVENT_PROPERTY",
      "eventCode": "purchase",
      "field": {"scope": "EVENT_PROPERTY", "eventCode": "purchase", "code": "amount"},
      "bucketMode": "CUSTOM",
      "buckets": [
        {"label": "0-10", "lowerInclusive": 0, "upperExclusive": 10},
        {"label": "10-50", "lowerInclusive": 10, "upperExclusive": 50},
        {"label": "50-100", "lowerInclusive": 50, "upperExclusive": 100},
        {"label": "100+", "lowerInclusive": 100, "upperExclusive": null}
      ]
    },
    "display": {"chartType": "HISTOGRAM"}
  }' | jq .
```

**预期**：`code=200`，按自定义金额区间分桶统计付费用户数。`upperExclusive=null` 表示无上限。

---

### 5.3 分布分析：DISCRETE 模式（离散值）

```bash
curl -s -X POST http://localhost:30000/report/analysis/query \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "schemaVersion": "1.0",
    "appId": 2077597832956723202,
    "analysisType": "DISTRIBUTION",
    "timeRange": {
      "startInclusive": "2026-07-21T00:00:00+08:00",
      "endExclusive": "2026-07-28T00:00:00+08:00"
    },
    "distribution": {
      "subjectType": "EVENT_PROPERTY",
      "eventCode": "app_start",
      "field": {"scope": "EVENT_PROPERTY", "eventCode": "app_start", "code": "channel"},
      "bucketMode": "DISCRETE"
    },
    "display": {"chartType": "PIE"}
  }' | jq .
```

**预期**：`code=200`，按 `channel` 离散值统计各渠道启动次数，饼图展示。

---

### 5.4 误差校验：无 distribution 定义块

```bash
curl -s -X POST http://localhost:30000/report/analysis/query \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "schemaVersion": "1.0",
    "appId": 2077597832956723202,
    "analysisType": "DISTRIBUTION",
    "timeRange": {
      "startInclusive": "2026-07-21T00:00:00+08:00",
      "endExclusive": "2026-07-28T00:00:00+08:00"
    },
    "metrics": [{"eventCode": "app_start", "aggregation": "COUNT"}]
  }' | jq .
```

**预期**：`code=40010`（ANALYSIS_DEFINITION_INVALID），DISTRIBUTION 类型必须提供 `distribution` 定义块。

---

### 5.5 误差校验：CUSTOM 模式无 buckets

```bash
curl -s -X POST http://localhost:30000/report/analysis/query \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "schemaVersion": "1.0",
    "appId": 2077597832956723202,
    "analysisType": "DISTRIBUTION",
    "timeRange": {
      "startInclusive": "2026-07-21T00:00:00+08:00",
      "endExclusive": "2026-07-28T00:00:00+08:00"
    },
    "distribution": {
      "subjectType": "EVENT_COUNT",
      "eventCode": "app_start",
      "bucketMode": "CUSTOM"
    }
  }' | jq .
```

**预期**：`code=40010`（ANALYSIS_DEFINITION_INVALID），CUSTOM 模式必须提供 `buckets` 数组。

---

## 六、属性分析（ATTRIBUTE）

> 属性分析对单个事件的属性字段做汇总统计，支持摘要模式（summary）和透视模式（pivot）。摘要模式：指定 fields 做聚合统计；透视模式：指定 rowFields + columnFields 做交叉透视。

### 6.1 属性分析：摘要模式（summary）

```bash
curl -s -X POST http://localhost:30000/report/analysis/query \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "schemaVersion": "1.0",
    "appId": 2077597832956723202,
    "analysisType": "ATTRIBUTE",
    "timeRange": {
      "startInclusive": "2026-07-21T00:00:00+08:00",
      "endExclusive": "2026-07-28T00:00:00+08:00"
    },
    "attribute": {
      "eventCode": "purchase",
      "fields": [
        {"scope": "EVENT_PROPERTY", "eventCode": "purchase", "code": "amount"},
        {"scope": "EVENT_PROPERTY", "eventCode": "purchase", "code": "channel"}
      ]
    },
    "display": {"chartType": "TABLE"}
  }' | jq .
```

**预期**：`code=200`，`data.rows` 为 `amount` 和 `channel` 的汇总统计（计数、去重、求和、均值等），`data.summary` 含全局汇总。

---

### 6.2 属性分析：透视模式（pivot）

```bash
curl -s -X POST http://localhost:30000/report/analysis/query \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "schemaVersion": "1.0",
    "appId": 2077597832956723202,
    "analysisType": "ATTRIBUTE",
    "timeRange": {
      "startInclusive": "2026-07-21T00:00:00+08:00",
      "endExclusive": "2026-07-28T00:00:00+08:00"
    },
    "attribute": {
      "eventCode": "purchase",
      "fields": [
        {"scope": "EVENT_PROPERTY", "eventCode": "purchase", "code": "amount"}
      ],
      "rowFields": [
        {"scope": "EVENT_PROPERTY", "eventCode": "purchase", "code": "channel"}
      ],
      "columnFields": [
        {"scope": "TIME", "code": "DAY"}
      ]
    },
    "display": {"chartType": "PIVOT"}
  }' | jq .
```

**预期**：`code=200`，`data.rows` 为透视表（行=渠道，列=日期，值=amount 汇总），`data.columns` 含动态列。

---

### 6.3 误差校验：无 attribute 定义块

```bash
curl -s -X POST http://localhost:30000/report/analysis/query \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "schemaVersion": "1.0",
    "appId": 2077597832956723202,
    "analysisType": "ATTRIBUTE",
    "timeRange": {
      "startInclusive": "2026-07-21T00:00:00+08:00",
      "endExclusive": "2026-07-28T00:00:00+08:00"
    },
    "metrics": [{"eventCode": "purchase", "aggregation": "COUNT"}]
  }' | jq .
```

**预期**：`code=40010`（ANALYSIS_DEFINITION_INVALID），ATTRIBUTE 类型必须提供 `attribute` 定义块。

---

### 6.4 误差校验：attributes 无 fields

```bash
curl -s -X POST http://localhost:30000/report/analysis/query \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "schemaVersion": "1.0",
    "appId": 2077597832956723202,
    "analysisType": "ATTRIBUTE",
    "timeRange": {
      "startInclusive": "2026-07-21T00:00:00+08:00",
      "endExclusive": "2026-07-28T00:00:00+08:00"
    },
    "attribute": {
      "eventCode": "purchase",
      "fields": []
    }
  }' | jq .
```

**预期**：`code=40010`（ANALYSIS_DEFINITION_INVALID），`fields` 不能为空。

---

## 七、能力查询

> 查询指定 appid 和 analysisType 下可用的 events 和 metrics 清单，用于前端构建分析配置 UI。

**端点**: `POST /report/analysis/capability`

### 7.1 事件分析能力

```bash
curl -s -X POST http://localhost:30000/report/analysis/capability \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"appId": 2077597832956723202, "analysisType": "EVENT"}' | jq .
```

**预期**：`code=200`，`data.events` 含 `["app_start", "app_crash", "register", "activate", "purchase"]`，`data.metrics` 含可用聚合列表。

### 7.2 留存分析能力

```bash
curl -s -X POST http://localhost:30000/report/analysis/capability \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"appId": 2077597832956723202, "analysisType": "RETENTION"}' | jq .
```

### 7.3 漏斗分析能力

```bash
curl -s -X POST http://localhost:30000/report/analysis/capability \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"appId": 2077597832956723202, "analysisType": "FUNNEL"}' | jq .
```

### 7.4 分布分析能力

```bash
curl -s -X POST http://localhost:30000/report/analysis/capability \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"appId": 2077597832956723202, "analysisType": "DISTRIBUTION"}' | jq .
```

### 7.5 属性分析能力

```bash
curl -s -X POST http://localhost:30000/report/analysis/capability \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"appId": 2077597832956723202, "analysisType": "ATTRIBUTE"}' | jq .
```

**所有能力查询预期**：`code=200`，`data.analysisType` 匹配请求类型，`data.appId` 匹配请求 appId。

---

## 八、参数校验边界

### 8.1 无效分析类型

```bash
curl -s -X POST http://localhost:30000/report/analysis/query \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "schemaVersion": "1.0",
    "appId": 2077597832956723202,
    "analysisType": "INVALID_TYPE",
    "timeRange": {
      "startInclusive": "2026-07-21T00:00:00+08:00",
      "endExclusive": "2026-07-28T00:00:00+08:00"
    },
    "metrics": [{"eventCode": "app_start", "aggregation": "COUNT"}]
  }' | jq .
```

**预期**：`code=400`（参数校验失败，框架级，未触达业务）。

---

### 8.2 无效 schemaVersion

```bash
curl -s -X POST http://localhost:30000/report/analysis/query \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "schemaVersion": "999.0",
    "appId": 2077597832956723202,
    "analysisType": "EVENT",
    "timeRange": {
      "startInclusive": "2026-07-21T00:00:00+08:00",
      "endExclusive": "2026-07-28T00:00:00+08:00"
    },
    "timeGrain": "DAY",
    "metrics": [{"eventCode": "app_start", "aggregation": "COUNT"}]
  }' | jq .
```

**预期**：`code=40010`（ANALYSIS_DEFINITION_INVALID），不支持的 schemaVersion。

---

### 8.3 时间范围 endExclusive 早于 startInclusive

```bash
curl -s -X POST http://localhost:30000/report/analysis/query \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "schemaVersion": "1.0",
    "appId": 2077597832956723202,
    "analysisType": "EVENT",
    "timeRange": {
      "startInclusive": "2026-07-28T00:00:00+08:00",
      "endExclusive": "2026-07-21T00:00:00+08:00"
    },
    "timeGrain": "DAY",
    "metrics": [{"eventCode": "app_start", "aggregation": "COUNT"}]
  }' | jq .
```

**预期**：`code=40010`（ANALYSIS_DEFINITION_INVALID），`endExclusive` 必须晚于 `startInclusive`。

---

### 8.4 缺少必填字段 appId

```bash
curl -s -X POST http://localhost:30000/report/analysis/query \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "schemaVersion": "1.0",
    "analysisType": "EVENT",
    "timeRange": {
      "startInclusive": "2026-07-21T00:00:00+08:00",
      "endExclusive": "2026-07-28T00:00:00+08:00"
    },
    "timeGrain": "DAY",
    "metrics": [{"eventCode": "app_start", "aggregation": "COUNT"}]
  }' | jq .
```

**预期**：`code=400`（参数校验失败，appId 必填）。

---

### 8.5 缺少必填字段 analysisType

```bash
curl -s -X POST http://localhost:30000/report/analysis/query \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "schemaVersion": "1.0",
    "appId": 2077597832956723202,
    "timeRange": {
      "startInclusive": "2026-07-21T00:00:00+08:00",
      "endExclusive": "2026-07-28T00:00:00+08:00"
    },
    "timeGrain": "DAY",
    "metrics": [{"eventCode": "app_start", "aggregation": "COUNT"}]
  }' | jq .
```

**预期**：`code=400`（参数校验失败，analysisType 必填）。

---

### 8.6 缺少 timeRange

```bash
curl -s -X POST http://localhost:30000/report/analysis/query \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "schemaVersion": "1.0",
    "appId": 2077597832956723202,
    "analysisType": "EVENT",
    "timeGrain": "DAY",
    "metrics": [{"eventCode": "app_start", "aggregation": "COUNT"}]
  }' | jq .
```

**预期**：`code=40010`（ANALYSIS_DEFINITION_INVALID），`timeRange` 必填。

---

### 8.7 EVENT 类型无 metrics

```bash
curl -s -X POST http://localhost:30000/report/analysis/query \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "schemaVersion": "1.0",
    "appId": 2077597832956723202,
    "analysisType": "EVENT",
    "timeRange": {
      "startInclusive": "2026-07-21T00:00:00+08:00",
      "endExclusive": "2026-07-28T00:00:00+08:00"
    },
    "timeGrain": "DAY",
    "metrics": []
  }' | jq .
```

**预期**：`code=40010`（ANALYSIS_DEFINITION_INVALID），EVENT 类型 `metrics` 不能为空。

---

### 8.8 EVENT 类型带不该有的 SPEC 定义块

```bash
curl -s -X POST http://localhost:30000/report/analysis/query \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "schemaVersion": "1.0",
    "appId": 2077597832956723202,
    "analysisType": "EVENT",
    "timeRange": {
      "startInclusive": "2026-07-21T00:00:00+08:00",
      "endExclusive": "2026-07-28T00:00:00+08:00"
    },
    "timeGrain": "DAY",
    "metrics": [{"eventCode": "app_start", "aggregation": "COUNT"}],
    "retention": {
      "initialEvent": {"eventCode": "register"},
      "returnEvent": {"eventCode": "app_start"},
      "periods": 7
    }
  }' | jq .
```

**预期**：`code=40010`（ANALYSIS_DEFINITION_INVALID），EVENT 类型不应携带 `retention` 定义块。

---

### 8.9 未授权访问（无 Token）

```bash
curl -s -X POST http://localhost:30000/report/analysis/query \
  -H 'Content-Type: application/json' \
  -d '{
    "schemaVersion": "1.0",
    "appId": 2077597832956723202,
    "analysisType": "EVENT",
    "timeRange": {
      "startInclusive": "2026-07-21T00:00:00+08:00",
      "endExclusive": "2026-07-28T00:00:00+08:00"
    },
    "timeGrain": "DAY",
    "metrics": [{"eventCode": "app_start", "aggregation": "COUNT"}]
  }' | jq .
```

**预期**：`code=401`（网关层 JWT 校验失败，未带 Token）。

---

## 九、端点清单

### 分析模块端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `/report/analysis/query` | POST | 执行分析查询（EVENT / RETENTION / FUNNEL / DISTRIBUTION / ATTRIBUTE） |
| `/report/analysis/capability` | POST | 查询指定 appid + analysisType 的能力清单（events、metrics） |

### 关联端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `/auth/v1/login` | POST | SaaS 公司成员登录，获取 accessToken |
| `/report/space/create` | POST | 创建空间，绑定 appid |
| `/report/report/create` | POST | 创建报表（含 analysisDefinition，可关联查询） |
| `/report/report/page` | POST | 报表分页查询 |

---

## 十、AnalysisDefinition 参数约束表

### 通用字段

| 字段 | 类型 | 必填 | 约束 |
|------|------|------|------|
| `schemaVersion` | String | 是 | 固定 `"1.0"` |
| `appId` | Long | 是 | 数据源 appid，须在用户权限快照内 |
| `analysisType` | String | 是 | 枚举：`EVENT` / `RETENTION` / `FUNNEL` / `DISTRIBUTION` / `ATTRIBUTE` |
| `timeRange` | Object | 是 | `startInclusive`（含）< `endExclusive`（不含），ISO 8601 带时区 |
| `timeGrain` | String | 否 | 时间粒度：`DAY` / `WEEK` / `MONTH` / `QUARTER` / `YEAR` / `MINUTE` |
| `timezone` | String | 否 | 时区，如 `"Asia/Shanghai"` |
| `filters` | Object | 否 | 全局筛选器 `FilterGroup` |
| `groupBy` | Array | 否 | 分组维度 `Grouping[]` |
| `sorts` | Array | 否 | 排序 `SortSpec[]` |
| `page` | Object | 否 | 分页 `PageSpec`（`pageNum` + `pageSize`） |
| `display` | Object | 否 | 展示配置 `DisplaySpec`（`chartType` + `options`） |

### Metric 字段

| 字段 | 类型 | 必填 | 约束 |
|------|------|------|------|
| `eventCode` | String | 是 | 事件英文名 |
| `aggregation` | String | 是 | 聚合函数：`COUNT` / `USER_COUNT` / `SUM` / `AVG` / `DISTINCT_COUNT` 等 |
| `alias` | String | 否 | 指标别名（用于排序、公式引用） |
| `field` | Object | 否 | `FieldRef`（SUM/AVG 等需指定属性字段） |
| `percentile` | BigDecimal | 否 | 百分位值（仅 `PERCENTILE` 聚合时用） |

### FieldRef 字段

| 字段 | 类型 | 必填 | 约束 |
|------|------|------|------|
| `scope` | String | 是 | `EVENT` / `EVENT_PROPERTY` / `USER_PROPERTY` / `TIME` / `OUTPUT` |
| `eventCode` | String | 否 | `scope=EVENT_PROPERTY` 时必填，指定属性所属事件 |
| `code` | String | 是 | 字段代码（如 `channel`、`amount`、`screen_height`） |

### FilterGroup 字段

| 字段 | 类型 | 必填 | 约束 |
|------|------|------|------|
| `logic` | String | 是 | `AND` / `OR` |
| `conditions` | Array | 否 | `FilterCondition[]` |
| `groups` | Array | 否 | `NestedGroup[]`（嵌套分组，见下方） |

**NestedGroup 字段**

| 字段 | 类型 | 必填 | 约束 |
|------|------|------|------|
| `logic` | String | 是 | `AND` / `OR` |
| `conditions` | FilterCondition[] | 是 | 非空数组 |

### FilterCondition 字段

| 字段 | 类型 | 必填 | 约束 |
|------|------|------|------|
| `field` | Object | 是 | `FieldRef` |
| `operator` | String | 是 | `EQ` / `NE` / `IN` / `GT` / `GTE` / `LT` / `LTE` / `BETWEEN` / `CONTAINS` / `IS_SET` 等 |
| `value` | Any | 否 | 单值（与 `values` 二选一） |
| `values` | Array | 否 | 多值（`IN` / `NOT_IN` 等操作符使用） |

### 按分析类型的专用字段

| 分析类型 | 专用字段 | 必填 | 核心约束 |
|---------|---------|------|---------|
| `EVENT` | `metrics` | 是 | 非空数组 |
| `EVENT` | `formulaIndicators` | 否 | 公式指标（`alias` + `formula` + `decimalPlaces` + `displayMode`） |
| `RETENTION` | `retention` | 是 | 含 `initialEvent`、`returnEvent`、`periods`（> 0） |
| `FUNNEL` | `funnel` | 是 | 含 `steps`（>= 2）、`windowSeconds`（> 0） |
| `DISTRIBUTION` | `distribution` | 是 | 含 `subjectType`、`eventCode`、`bucketMode`；CUSTOM 模式需 `buckets` |
| `ATTRIBUTE` | `attribute` | 是 | 含 `eventCode`、`fields`（非空）；透视模式还需 `rowFields` + `columnFields` |

### 业务码对照表

| code | 含义 | 触发场景 |
|------|------|---------|
| `200` | 成功 | 查询正确返回 |
| `400` | 参数校验失败 | 缺失必填字段、类型不匹配、枚举值非法（框架级，未触达业务） |
| `40010` | ANALYSIS_DEFINITION_INVALID | 缺少专用定义块、periods <= 0、steps < 2、metrics 为空等业务规则校验失败 |
| `40310` | PERMISSION_DENIED | 用户不在 appId 的权限快照中 |
| `40410` | REPORT_NOT_FOUND | 查询的报表不存在 |
| `50010` | REPORT_INTERNAL_ERROR | 内部错误（hologres 查询失败、下游超时等） |

---

## 十一、入参组合指南

> 面向前端联调：完整列出 `POST /report/analysis/query` 的入参字段、组合规则与聚合表达式。

### 11.1 入参总览

```json
{
  "schemaVersion": "1.0",
  "appId": 2077597832956723202,
  "analysisType": "EVENT",
  "timezone": "Asia/Shanghai",
  "timeRange": {
    "startInclusive": "2026-07-21T00:00:00+08:00",
    "endExclusive":   "2026-07-28T00:00:00+08:00"
  },
  "timeGrain": "DAY",
  "metrics": [
    {"alias": "启动次数", "eventCode": "app_start", "aggregation": "COUNT"}
  ],
  "formulaIndicators": [
    {"alias": "ARPU", "formula": "付费总额 / 启动用户数", "decimalPlaces": 2, "displayMode": "NUMBER"}
  ],
  "filters": {
    "logic": "AND",
    "conditions": [
      {"field": {"scope": "EVENT_PROPERTY", "eventCode": "app_start", "code": "channel"}, "operator": "EQ", "value": "organic"}
    ]
  },
  "groupBy": [
    {"alias": "渠道", "field": {"scope": "EVENT_PROPERTY", "eventCode": "app_start", "code": "channel"}, "mode": "VALUE"}
  ],
  "sorts": [{"field": "启动次数", "direction": "DESC"}],
  "page": {"pageNum": 1, "pageSize": 10},
  "display": {"chartType": "LINE"}
}
```

| 字段 | 类型 | 必填 | 产生 SELECT 列 | 产生 WHERE 条件 | 说明 |
|------|------|------|---------------|----------------|------|
| `schemaVersion` | String | 是 | — | — | 固定 `"1.0"` |
| `appId` | Long | 是 | — | `app_id = ?` | 数据源，须在用户权限快照内 |
| `analysisType` | String | 是 | — | — | `EVENT` / `RETENTION` / `FUNNEL` / `DISTRIBUTION` / `ATTRIBUTE` |
| `timezone` | String | 否 | — | — | 时区，缺省 `UTC` |
| `timeRange` | Object | 是 | — | `event_time >= ? AND event_time < ?` | `startInclusive`（含）< `endExclusive`（不含） |
| `timeGrain` | String | 否 | `date_trunc(..., event_time) AS "timeBucket"` | — | `DAY` / `WEEK` / `MONTH` / `QUARTER` / `YEAR` / `MINUTE`；不传=合计 |
| `metrics` | Array | 是 | 每个元素一列聚合表达式 | 事件名 `IN (...)` 或 `= ?` | 非空数组，见 §11.4 |
| `formulaIndicators` | Array | 否 | 子查询外层每元素一列 | — | 公式引用 `metrics` 的 `alias`，见 §11.5 |
| `filters` | Object | 否 | — | `AND (编译结果)` | 全局筛选，见 §11.2 |
| `groupBy` | Array | 否 | 每个元素一列 `field AS alias` | — | 分组维度，见 §11.3 |
| `sorts` | Array | 否 | — | — | `ORDER BY alias DESC/ASC` |
| `page` | Object | 否 | — | — | `LIMIT pageSize OFFSET (pageNum-1)*pageSize` |
| `display` | Object | 否 | — | — | 透传到响应 `data.display`，不参与 SQL |

### 11.2 筛选结构 FilterGroup

```json
{
  "logic": "AND",
  "conditions": [
    {
      "field": {"scope": "EVENT_PROPERTY", "eventCode": "app_start", "code": "channel"},
      "operator": "EQ",
      "value": "organic"
    }
  ],
  "groups": [
    {
      "logic": "OR",
      "conditions": [
        {"field": {"scope": "EVENT_PROPERTY", "eventCode": "app_start", "code": "platform"}, "operator": "EQ", "value": "ios"},
        {"field": {"scope": "EVENT_PROPERTY", "eventCode": "app_start", "code": "platform"}, "operator": "EQ", "value": "android"}
      ]
    }
  ]
}
```

**FilterGroup 字段**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `logic` | String | 是 | 连接符：`AND` / `OR` |
| `conditions` | FilterCondition[] | 否 | 平铺条件列表 |
| `groups` | NestedGroup[] | 否 | 嵌套条件组，与 `conditions` 同级，由 `logic` 连接 |

**NestedGroup 字段**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `logic` | String | 是 | 组内连接符：`AND` / `OR` |
| `conditions` | FilterCondition[] | 是 | 组内条件列表（非空） |

**SQL 编译结果示例**

上例编译为 `(channel = ? AND (platform = ? OR platform = ?))`，整体作为 WHERE 的一个 `AND (...)` 子句注入。

**筛选的作用域**

| 筛选位置 | 契约字段 | 生效范围 |
|---------|---------|---------|
| 全局筛选 | `filters` | 所有分析的 WHERE 公共条件 |
| 步骤筛选 | `retention.initialEvent.filters` / `funnel.steps[].filters` | 仅该步骤的 CTE |
| 指标筛选 | `metrics[].field` + `metrics[].aggregation` | 仅该指标的计算表达式 |

### 11.3 分组维度 Grouping

```json
{
  "alias": "渠道",
  "field": {"scope": "EVENT_PROPERTY", "eventCode": "app_start", "code": "channel"},
  "mode": "VALUE"
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `alias` | String | 是 | 分组列别名，可作为 `sorts[].field` 引用 |
| `field` | FieldRef | 是 | 分组字段，`scope` = `EVENT_PROPERTY` / `USER_PROPERTY` 等 |
| `mode` | String | 否 | 分组模式，默认 `VALUE` |

每个 `groupBy` 元素产生一列 `field 表达式 AS alias`，并加入 GROUP BY 列表。

### 11.4 聚合类型 Aggregation 对照表

| aggregation | 适用属性类型 | SQL 表达式 | 说明 |
|---|---|---|---|
| `COUNT` | — | `COUNT(*)`（DWD）/ `SUM(event_count)`（DWS） | 事件触发次数 |
| `USER_COUNT` | — | `COUNT(DISTINCT user_id)` | 触发用户数（去重） |
| `AVG_PER_USER` | — | `COUNT(*)::NUMERIC / NULLIF(COUNT(DISTINCT user_id), 0)` | 人均次数 |
| `SUM` | 数值型 | `SUM((field)::NUMERIC)` | 属性值求和 |
| `AVG` | 数值型 | `AVG((field)::NUMERIC)` | 属性值均值 |
| `DISTINCT_COUNT` | 文本/数值型 | `COUNT(DISTINCT field)` | 属性值去重计数 |

> **注意**：EVENT 分析目前只支持以上 6 种聚合。留存分析、属性分析另有 `MEDIAN`、`PERCENTILE`、`VARIANCE`、`STDDEV`、`TRUE_COUNT`、`FALSE_COUNT` 等扩展聚合，详见对应分析类型的 E2E 示例。

**多事件处理**：当 `metrics` 中包含多个不同 `eventCode` 时，每个指标自动追加 `FILTER (WHERE event_name = ?)` 限定到自己的事件，WHERE 子句宽松为 `event_name IN (...)`。示例：

```json
"metrics": [
  {"alias": "启动次数", "eventCode": "app_start", "aggregation": "COUNT"},
  {"alias": "付费总额", "eventCode": "purchase", "aggregation": "SUM", "field": {"scope": "EVENT_PROPERTY", "eventCode": "purchase", "code": "amount"}}
]
```

→ SQL
```sql
SELECT COUNT(*) FILTER (WHERE event_name = 'app_start') AS "启动次数",
       SUM((event_properties->>'amount')::NUMERIC) FILTER (WHERE event_name = 'purchase') AS "付费总额"
FROM dwd_event_detail
WHERE event_name IN ('app_start', 'purchase')
```

### 11.5 公式指标 FormulaIndicator

```json
{
  "alias": "ARPU",
  "formula": "付费总额 / 启动用户数",
  "decimalPlaces": 2,
  "displayMode": "NUMBER"
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `alias` | String | 是 | 公式结果列别名，不可与其他指标/公式重复 |
| `formula` | String | 是 | 算术表达式，引用 `metrics` 和 `formulaIndicators` 的 `alias` |
| `decimalPlaces` | Integer | 否 | 保留小数位数 |
| `displayMode` | String | 否 | 展示模式：`NUMBER` / `PERCENTAGE` |

公式指标编译为子查询外层 SELECT，可引用内层 `metrics` 的别名做四则运算。`formula` 中使用的别名必须在 `metrics` 或前面的 `formulaIndicators` 中已定义。

### 11.6 条件参数一览

| 参数 | 产生的 SQL 片段 | 位置 |
|------|----------------|------|
| `"operator": "EQ", "value": "organic"` | `field = ?` | WHERE |
| `"operator": "NE", "value": "x"` | `field <> ?` | WHERE |
| `"operator": "GT", "value": 5` | `field > ?` | WHERE |
| `"operator": "GTE", "value": 5` | `field >= ?` | WHERE |
| `"operator": "LT", "value": 5` | `field < ?` | WHERE |
| `"operator": "LTE", "value": 5` | `field <= ?` | WHERE |
| `"operator": "IN", "values": ["a","b"]` | `field IN (?, ?)` | WHERE |
| `"operator": "NOT_IN", "values": ["a","b"]` | `field NOT IN (?, ?)` | WHERE |
| `"operator": "BETWEEN", "values": [1, 10]` | `field BETWEEN ? AND ?` | WHERE |
| `"operator": "CONTAINS", "value": "keyword"` | `field LIKE '%' \|\| ? \|\| '%'` | WHERE |
| `"operator": "IS_SET"` | `field IS NOT NULL` | WHERE |
| `"operator": "IS_NOT_SET"` | `field IS NULL` | WHERE |
| `"operator": "BEFORE", "value": "2026-01-01"` | `field < ?` | WHERE |
| `"operator": "AFTER", "value": "2026-01-01"` | `field > ?` | WHERE |

---

## 附录：一键验证脚本

将以下内容保存为 `docs/data-platform/report/e2e-analysis.sh`：

```bash
#!/usr/bin/env bash
# 分析模块 E2E 快速验证脚本
# 前置：网关 30000、auth 30005、report 30006、holo 已启动，seed-analysis-events.sh 已执行

set -uo pipefail

GATEWAY="${GATEWAY:-http://localhost:30000}"
APP_ID=2077597832956723202
PASS=0
FAIL=0

log()  { echo "[$(date +%H:%M:%S)] $*"; }
ok()   { echo "  PASS: $*"; PASS=$((PASS+1)); }
fail() { echo "  FAIL: $*"; FAIL=$((FAIL+1)); }

api_call() {
    local body="$1" expect="${2:-200}"
    local resp rc
    resp=$(curl -s -X POST "$GATEWAY/report/analysis/query" \
        -H 'Content-Type: application/json' \
        -H "Authorization: Bearer $TOKEN" \
        -d "$body")
    rc=$(echo "$resp" | jq -r '.code // empty' 2>/dev/null)
    if [ "$rc" = "$expect" ]; then
        ok "code=$rc"
    else
        fail "期望 code=$expect 实际 code=$rc body=$resp"
    fi
}

# 登录
log "=== 登录 ==="
LOGIN_RESP=$(curl -s -X POST "$GATEWAY/auth/v1/login" \
    -H 'Content-Type: application/json' \
    -d '{"email":"admin@acme.com","password":"gJJKF5kFBlRHyqc2"}')
TOKEN=$(echo "$LOGIN_RESP" | jq -r '.data.accessToken')
[ -z "$TOKEN" ] && { fail "登录失败"; exit 1; }
ok "登录成功"

BASE_JSON=$(cat <<JSON
{
  "schemaVersion": "1.0",
  "appId": $APP_ID,
  "timeRange": {
    "startInclusive": "2026-07-21T00:00:00+08:00",
    "endExclusive": "2026-07-28T00:00:00+08:00"
  }
}
JSON
)

# 事件分析
log "=== 事件分析 ==="
api_call "$(echo "$BASE_JSON" | jq '. + {analysisType:"EVENT",timeGrain:"DAY",metrics:[{eventCode:"app_start",aggregation:"COUNT"}]}' -c)"

# 留存分析
log "=== 留存分析 ==="
api_call "$(echo "$BASE_JSON" | jq '. + {analysisType:"RETENTION",retention:{initialEvent:{eventCode:"register"},returnEvent:{eventCode:"app_start"},periods:7}}' -c)"

# 漏斗分析
log "=== 漏斗分析 ==="
api_call "$(echo "$BASE_JSON" | jq '. + {analysisType:"FUNNEL",funnel:{steps:[{eventCode:"register"},{eventCode:"activate"},{eventCode:"purchase"}],windowSeconds:604800}}' -c)"

# 分布分析
log "=== 分布分析 ==="
api_call "$(echo "$BASE_JSON" | jq '. + {analysisType:"DISTRIBUTION",distribution:{subjectType:"EVENT_COUNT",eventCode:"app_start",bucketMode:"AUTO"}}' -c)"

# 属性分析
log "=== 属性分析 ==="
api_call "$(echo "$BASE_JSON" | jq '. + {analysisType:"ATTRIBUTE",attribute:{eventCode:"purchase",fields:[{scope:"EVENT_PROPERTY",eventCode:"purchase",code:"amount"}]}}' -c)"

# 能力查询
log "=== 能力查询 ==="
for at in EVENT RETENTION FUNNEL DISTRIBUTION ATTRIBUTE; do
    resp=$(curl -s -X POST "$GATEWAY/report/analysis/capability" \
        -H 'Content-Type: application/json' \
        -H "Authorization: Bearer $TOKEN" \
        -d "{\"appId\":$APP_ID,\"analysisType\":\"$at\"}")
    rc=$(echo "$resp" | jq -r '.code // empty' 2>/dev/null)
    [ "$rc" = "200" ] && ok "capability/$at code=$rc" || fail "capability/$at code=$rc"
done

# 参数校验
log "=== 参数校验 ==="
api_call "$(echo "$BASE_JSON" | jq '. + {analysisType:"INVALID_TYPE",metrics:[{eventCode:"app_start",aggregation:"COUNT"}]}' -c)" 400
api_call "$(echo "$BASE_JSON" | jq '. + {analysisType:"RETENTION",metrics:[{eventCode:"register",aggregation:"COUNT"}]}' -c)" 40010

log ""
log "========== 结果：PASS=$PASS FAIL=$FAIL =========="
[ $FAIL -gt 0 ] && exit 1
exit 0
```

---

## 附录：Response 字段说明

`POST /report/analysis/query` 成功时返回 `ResultData<QueryResult>`：

```json
{
  "code": 200,
  "data": {
    "queryId": "uuid",
    "schemaVersion": "1.0",
    "metadata": {
      "queryTimeMs": 123,
      "source": "hologres",
      "cached": false
    },
    "columns": [
      {"name": "date", "type": "DATE", "label": "日期"},
      {"name": "启动次数", "type": "NUMBER", "label": "启动次数"}
    ],
    "rows": [
      ["2026-07-21", 1234],
      ["2026-07-22", 2345]
    ],
    "summary": {},
    "page": {"pageNum": 1, "pageSize": 50, "total": 7}
  }
}
```

| 字段 | 说明 |
|------|------|
| `queryId` | 查询唯一标识 |
| `metadata.queryTimeMs` | 查询耗时（毫秒） |
| `metadata.source` | 数据源（`hologres`） |
| `metadata.cached` | 是否命中缓存 |
| `columns` | 列定义（名称、类型、标签） |
| `rows` | 数据行（二维数组） |
| `summary` | 汇总（留存为总体留存率、属性为全局统计） |
| `page` | 分页信息（total 为总行数） |