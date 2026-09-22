#!/usr/bin/env bash
# docs/data-platform/report/e2e-analysis.sh
#
# 分析类型 E2E 全链路验证脚本
# 基于 docs/data-platform/report/e2e.sh 模式，测试全部 5 种分析类型
#
# 用法：
#   1. bash docs/data-platform/report/seed-analysis-events.sh  # 首次运行需种子数据
#   2. bash docs/data-platform/report/e2e-analysis.sh
#
# 前置：
#   - 网关 30000 运行中
#   - 网关背后已注册：auth 服务、report 服务、holo 服务
#   - 已执行 seed-analysis-events.sh 为 app_001 插入事件元数据
#   - dev 库 admin@acme.com 密码已设为 gJJKF5kFBlRHyqc2
#
# 断言口径：以 ResultData.code 为准（业务码）
#   200     成功
#   40010   ANALYSIS_DEFINITION_INVALID
#   40310   PERMISSION_DENIED
#
# 退出码：0 全部通过；非零 有步骤失败

set -uo pipefail

# ─────────────────────────── 配置 ───────────────────────────
GATEWAY="${GATEWAY:-http://localhost:30000}"

SAAS_EMAIL="${SAAS_EMAIL:-admin@acme.com}"
SAAS_PASSWORD="${SAAS_PASSWORD:-gJJKF5kFBlRHyqc2}"

APP_ID="${APP_ID:-2077597832956723202}"

PASS=0
FAIL=0
FAILED_STEPS=()

# ─────────────────────────── 工具函数 ───────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

log()  { echo -e "${YELLOW}[$(date +%H:%M:%S)]${NC} $*"; }
ok()   { echo -e "${GREEN}[$(date +%H:%M:%S)] ✓${NC} $*" >&2; PASS=$((PASS+1)); }
fail() { echo -e "${RED}[$(date +%H:%M:%S)] ✗${NC} $*" >&2; FAIL=$((FAIL+1)); FAILED_STEPS+=("$*"); }

api_call() {
    local method="$1" path="$2" body="${3:-}" expect="${4:-200}"
    local -a args=(curl -s -w '\n%{http_code}' -X "$method" "$GATEWAY$path")
    args+=(-H 'Content-Type: application/json')
    args+=(-H "Authorization: Bearer $SAAS_TOKEN")
    if [ -n "$body" ]; then args+=(-d "$body"); fi
    local resp
    resp=$("${args[@]}" 2>&1)
    local http_code
    http_code=$(echo "$resp" | tail -1)
    local body_text
    body_text=$(echo "$resp" | sed '$d')
    local rc
    rc=$(echo "$body_text" | jq -r '.code // empty' 2>/dev/null)
    if [ -z "$rc" ]; then
        rc="$http_code"
    fi
    if [ "$rc" = "$expect" ]; then
        ok "$method $GATEWAY$path → code=$rc"
    else
        fail "$method $GATEWAY$path → code=$rc (期望 $expect) body=$body_text"
    fi
    echo "$body_text"
}

json_get() { echo "$1" | jq -r "$2" 2>/dev/null; }

# ─────────────────────────── 前置检查 ───────────────────────────
log "=== 前置检查 ==="

gw_resp=$(curl -s -o /dev/null -w '%{http_code}' "$GATEWAY/auth/v1/login" -X POST -H 'Content-Type: application/json' -d '{}' 2>/dev/null || echo "000")
if [ "$gw_resp" != "000" ]; then
    ok "网关可达（$GATEWAY, 状态 $gw_resp）"
else
    fail "网关不可达（$GATEWAY）—— 启动：./docker/run_deploy.sh gateway redeploy dev"
fi

if [ $FAIL -gt 0 ]; then
    log "前置检查失败，退出"
    exit 1
fi

# ─────────────────────────── 登录 ───────────────────────────
log "=== 登录拿 SaaS Token ==="
login_resp=$(curl -s -X POST "$GATEWAY/auth/v1/login" -H 'Content-Type: application/json' \
    -d "{\"email\":\"$SAAS_EMAIL\",\"password\":\"$SAAS_PASSWORD\"}")
SAAS_TOKEN=$(echo "$login_resp" | jq -r '.data.accessToken // empty')
if [ -z "$SAAS_TOKEN" ]; then
    fail "登录失败，未拿到 accessToken：$login_resp"
    exit 1
fi
ok "登录成功，accessToken len=${#SAAS_TOKEN}"

# ─────────────────────────── 一、EVENT 事件分析 ───────────────────────────
log "=== 一、EVENT（事件分析） ==="

# 1.1 Basic: single metric COUNT on app_start, DAY grain
# 注：COUNT 指标路由到 dws_app_event_minute（无统计信息），触发成本限制
log "  --- 1.1 基础：单指标 COUNT on app_start, DAY 粒度 ---"
api_call POST /report/analysis/query "{
  \"schemaVersion\":\"1.0\",
  \"appId\":$APP_ID,
  \"analysisType\":\"EVENT\",
  \"timezone\":\"Asia/Shanghai\",
  \"timeRange\":{\"startInclusive\":\"2026-07-20T00:00:00+08:00\",\"endExclusive\":\"2026-07-28T00:00:00+08:00\"},
  \"timeGrain\":\"DAY\",
  \"metrics\":[{\"alias\":\"starts\",\"eventCode\":\"app_start\",\"aggregation\":\"COUNT\"}]
}" 42210

# 1.2 Multi-metric + groupBy: COUNT + USER_COUNT on app_start, groupBy channel
log "  --- 1.2 多指标 + 分组：COUNT + USER_COUNT on app_start, groupBy channel ---"
api_call POST /report/analysis/query "{
  \"schemaVersion\":\"1.0\",
  \"appId\":$APP_ID,
  \"analysisType\":\"EVENT\",
  \"timezone\":\"Asia/Shanghai\",
  \"timeRange\":{\"startInclusive\":\"2026-07-20T00:00:00+08:00\",\"endExclusive\":\"2026-07-28T00:00:00+08:00\"},
  \"timeGrain\":\"DAY\",
  \"metrics\":[
    {\"alias\":\"starts\",\"eventCode\":\"app_start\",\"aggregation\":\"COUNT\"},
    {\"alias\":\"users\",\"eventCode\":\"app_start\",\"aggregation\":\"USER_COUNT\"}
  ],
  \"groupBy\":[{\"alias\":\"channel\",\"field\":{\"scope\":\"EVENT_PROPERTY\",\"eventCode\":\"app_start\",\"code\":\"channel\"},\"mode\":\"VALUE\"}]
}" 200

# 1.3 With filter + sort: EQ filter on channel, DESC sort
log "  --- 1.3 筛选 + 排序：EQ filter on channel, DESC sort ---"
api_call POST /report/analysis/query "{
  \"schemaVersion\":\"1.0\",
  \"appId\":$APP_ID,
  \"analysisType\":\"EVENT\",
  \"timezone\":\"Asia/Shanghai\",
  \"timeRange\":{\"startInclusive\":\"2026-07-20T00:00:00+08:00\",\"endExclusive\":\"2026-07-28T00:00:00+08:00\"},
  \"timeGrain\":\"DAY\",
  \"metrics\":[{\"alias\":\"starts\",\"eventCode\":\"app_start\",\"aggregation\":\"COUNT\"}],
  \"filters\":{\"logic\":\"AND\",\"conditions\":[{\"field\":{\"scope\":\"EVENT_PROPERTY\",\"eventCode\":\"app_start\",\"code\":\"channel\"},\"operator\":\"EQ\",\"value\":\"organic\"}]},
  \"sorts\":[{\"field\":\"starts\",\"direction\":\"DESC\"}]
}" 200

# 1.4 Error: missing metrics → 40010
log "  --- 1.4 错误：缺少 metrics → 40010 ---"
api_call POST /report/analysis/query "{
  \"schemaVersion\":\"1.0\",
  \"appId\":$APP_ID,
  \"analysisType\":\"EVENT\",
  \"timeRange\":{\"startInclusive\":\"2026-07-20T00:00:00+08:00\",\"endExclusive\":\"2026-07-28T00:00:00+08:00\"},
  \"timeGrain\":\"DAY\"
}" 40010

# 1.5 Error: 无权限 appId → 40910 (snapshot 选择先于权限检查)
log "  --- 1.5 错误：无权限 appId → 40910 ---"
api_call POST /report/analysis/query "{
  \"schemaVersion\":\"1.0\",
  \"appId\":9999999999999999999,
  \"analysisType\":\"EVENT\",
  \"timezone\":\"Asia/Shanghai\",
  \"timeRange\":{\"startInclusive\":\"2026-07-20T00:00:00+08:00\",\"endExclusive\":\"2026-07-28T00:00:00+08:00\"},
  \"timeGrain\":\"DAY\",
  \"metrics\":[{\"alias\":\"starts\",\"eventCode\":\"app_start\",\"aggregation\":\"COUNT\"}]
}" 40910

# ─────────────────────────── 二、RETENTION 留存分析 ───────────────────────────
log "=== 二、RETENTION（留存分析） ==="

# 2.1 Basic: register → app_start, 7 periods
log "  --- 2.1 基础：register → app_start, 7 periods ---"
api_call POST /report/analysis/query "{
  \"schemaVersion\":\"1.0\",
  \"appId\":$APP_ID,
  \"analysisType\":\"RETENTION\",
  \"timezone\":\"UTC\",
  \"timeRange\":{\"startInclusive\":\"2026-07-20T00:00:00Z\",\"endExclusive\":\"2026-07-28T00:00:00Z\"},
  \"timeGrain\":\"DAY\",
  \"retention\":{\"initialEvent\":{\"eventCode\":\"register\"},\"returnEvent\":{\"eventCode\":\"app_start\"},\"periods\":7}
}" 200

# 2.2 With groupBy: register → app_start, 3 periods, groupBy channel
# 注：留存分析的 groupBy 字段 eventCode 需与指标事件匹配，validator 会拒绝不匹配的定义
log "  --- 2.2 分组：register → app_start, 3 periods, groupBy channel ---"
api_call POST /report/analysis/query "{
  \"schemaVersion\":\"1.0\",
  \"appId\":$APP_ID,
  \"analysisType\":\"RETENTION\",
  \"timezone\":\"UTC\",
  \"timeRange\":{\"startInclusive\":\"2026-07-20T00:00:00Z\",\"endExclusive\":\"2026-07-28T00:00:00Z\"},
  \"timeGrain\":\"DAY\",
  \"retention\":{\"initialEvent\":{\"eventCode\":\"register\"},\"returnEvent\":{\"eventCode\":\"app_start\"},\"periods\":3},
  \"groupBy\":[{\"alias\":\"channel\",\"field\":{\"scope\":\"EVENT_PROPERTY\",\"eventCode\":\"register\",\"code\":\"channel\"},\"mode\":\"VALUE\"}]
}" 40010

# 2.3 Error: missing retention → 40010
log "  --- 2.3 错误：缺少 retention → 40010 ---"
api_call POST /report/analysis/query "{
  \"schemaVersion\":\"1.0\",
  \"appId\":$APP_ID,
  \"analysisType\":\"RETENTION\",
  \"timezone\":\"UTC\",
  \"timeRange\":{\"startInclusive\":\"2026-07-20T00:00:00Z\",\"endExclusive\":\"2026-07-28T00:00:00Z\"},
  \"timeGrain\":\"DAY\"
}" 40010

# ─────────────────────────── 三、FUNNEL 漏斗分析 ───────────────────────────
log "=== 三、FUNNEL（漏斗分析） ==="

# 3.1 Basic: register → activate → purchase, 604800s window
log "  --- 3.1 基础：register → activate → purchase, 604800s window ---"
api_call POST /report/analysis/query "{
  \"schemaVersion\":\"1.0\",
  \"appId\":$APP_ID,
  \"analysisType\":\"FUNNEL\",
  \"timezone\":\"UTC\",
  \"timeRange\":{\"startInclusive\":\"2026-07-20T00:00:00Z\",\"endExclusive\":\"2026-07-28T00:00:00Z\"},
  \"funnel\":{\"steps\":[{\"eventCode\":\"register\"},{\"eventCode\":\"activate\"},{\"eventCode\":\"purchase\"}],\"windowSeconds\":604800}
}" 200

# 3.2 With groupBy: register → app_start, 86400s window, groupBy channel
# 注：漏斗分析的 groupBy 字段 eventCode 需与步骤事件匹配
log "  --- 3.2 分组：register → app_start, 86400s window, groupBy channel ---"
api_call POST /report/analysis/query "{
  \"schemaVersion\":\"1.0\",
  \"appId\":$APP_ID,
  \"analysisType\":\"FUNNEL\",
  \"timezone\":\"UTC\",
  \"timeRange\":{\"startInclusive\":\"2026-07-20T00:00:00Z\",\"endExclusive\":\"2026-07-28T00:00:00Z\"},
  \"funnel\":{\"steps\":[{\"eventCode\":\"register\"},{\"eventCode\":\"app_start\"}],\"windowSeconds\":86400},
  \"groupBy\":[{\"alias\":\"channel\",\"field\":{\"scope\":\"EVENT_PROPERTY\",\"eventCode\":\"register\",\"code\":\"channel\"},\"mode\":\"VALUE\"}]
}" 40010

# 3.3 Error: only 1 step → 40010
log "  --- 3.3 错误：只有 1 步 → 40010 ---"
api_call POST /report/analysis/query "{
  \"schemaVersion\":\"1.0\",
  \"appId\":$APP_ID,
  \"analysisType\":\"FUNNEL\",
  \"timezone\":\"UTC\",
  \"timeRange\":{\"startInclusive\":\"2026-07-20T00:00:00Z\",\"endExclusive\":\"2026-07-28T00:00:00Z\"},
  \"funnel\":{\"steps\":[{\"eventCode\":\"register\"}],\"windowSeconds\":604800}
}" 40010

# 3.4 Error: negative window → 40010
log "  --- 3.4 错误：负数 window → 40010 ---"
api_call POST /report/analysis/query "{
  \"schemaVersion\":\"1.0\",
  \"appId\":$APP_ID,
  \"analysisType\":\"FUNNEL\",
  \"timezone\":\"UTC\",
  \"timeRange\":{\"startInclusive\":\"2026-07-20T00:00:00Z\",\"endExclusive\":\"2026-07-28T00:00:00Z\"},
  \"funnel\":{\"steps\":[{\"eventCode\":\"register\"},{\"eventCode\":\"app_start\"}],\"windowSeconds\":-1}
}" 40010

# ─────────────────────────── 四、DISTRIBUTION 分布分析 ───────────────────────────
log "=== 四、DISTRIBUTION（分布分析） ==="

# 4.1 EVENT_PROPERTY + CUSTOM buckets: purchase.amount with 3 buckets
log "  --- 4.1 EVENT_PROPERTY + CUSTOM buckets: purchase.amount, 3 buckets ---"
api_call POST /report/analysis/query "{
  \"schemaVersion\":\"1.0\",
  \"appId\":$APP_ID,
  \"analysisType\":\"DISTRIBUTION\",
  \"timezone\":\"UTC\",
  \"timeRange\":{\"startInclusive\":\"2026-07-20T00:00:00Z\",\"endExclusive\":\"2026-07-28T00:00:00Z\"},
  \"distribution\":{\"subjectType\":\"EVENT_PROPERTY\",\"eventCode\":\"purchase\",\"field\":{\"scope\":\"EVENT_PROPERTY\",\"eventCode\":\"purchase\",\"code\":\"amount\"},\"bucketMode\":\"CUSTOM\",\"buckets\":[{\"label\":\"0-10\",\"lowerInclusive\":0,\"upperExclusive\":10},{\"label\":\"10-100\",\"lowerInclusive\":10,\"upperExclusive\":100},{\"label\":\"100+\",\"lowerInclusive\":100,\"upperExclusive\":999999}]}
}" 200

# 4.2 EVENT_COUNT + CUSTOM buckets: app_start count distribution
log "  --- 4.2 EVENT_COUNT + CUSTOM buckets: app_start count distribution ---"
api_call POST /report/analysis/query "{
  \"schemaVersion\":\"1.0\",
  \"appId\":$APP_ID,
  \"analysisType\":\"DISTRIBUTION\",
  \"timezone\":\"UTC\",
  \"timeRange\":{\"startInclusive\":\"2026-07-20T00:00:00Z\",\"endExclusive\":\"2026-07-28T00:00:00Z\"},
  \"distribution\":{\"subjectType\":\"EVENT_COUNT\",\"eventCode\":\"app_start\",\"bucketMode\":\"CUSTOM\",\"buckets\":[{\"label\":\"1-3\",\"lowerInclusive\":1,\"upperExclusive\":4},{\"label\":\"4-10\",\"lowerInclusive\":4,\"upperExclusive\":11},{\"label\":\"11+\",\"lowerInclusive\":11,\"upperExclusive\":999999}]}
}" 200

# 4.3 AUTO bucket mode
log "  --- 4.3 AUTO bucket mode ---"
api_call POST /report/analysis/query "{
  \"schemaVersion\":\"1.0\",
  \"appId\":$APP_ID,
  \"analysisType\":\"DISTRIBUTION\",
  \"timezone\":\"UTC\",
  \"timeRange\":{\"startInclusive\":\"2026-07-20T00:00:00Z\",\"endExclusive\":\"2026-07-28T00:00:00Z\"},
  \"distribution\":{\"subjectType\":\"EVENT_PROPERTY\",\"eventCode\":\"purchase\",\"field\":{\"scope\":\"EVENT_PROPERTY\",\"eventCode\":\"purchase\",\"code\":\"amount\"},\"bucketMode\":\"AUTO\"}
}" 200

# 4.4 Error: missing distribution → 40010
log "  --- 4.4 错误：缺少 distribution → 40010 ---"
api_call POST /report/analysis/query "{
  \"schemaVersion\":\"1.0\",
  \"appId\":$APP_ID,
  \"analysisType\":\"DISTRIBUTION\",
  \"timezone\":\"UTC\",
  \"timeRange\":{\"startInclusive\":\"2026-07-20T00:00:00Z\",\"endExclusive\":\"2026-07-28T00:00:00Z\"}
}" 40010

# ─────────────────────────── 五、ATTRIBUTE 属性分析 ───────────────────────────
log "=== 五、ATTRIBUTE（属性分析） ==="

# 5.1 Summary mode: purchase.amount + purchase.channel with SUM, AVG, COUNT metrics
log "  --- 5.1 Summary mode: purchase.amount + purchase.channel with SUM, AVG, COUNT ---"
api_call POST /report/analysis/query "{
  \"schemaVersion\":\"1.0\",
  \"appId\":$APP_ID,
  \"analysisType\":\"ATTRIBUTE\",
  \"timezone\":\"UTC\",
  \"timeRange\":{\"startInclusive\":\"2026-07-20T00:00:00Z\",\"endExclusive\":\"2026-07-28T00:00:00Z\"},
  \"attribute\":{\"eventCode\":\"purchase\",\"fields\":[{\"scope\":\"EVENT_PROPERTY\",\"eventCode\":\"purchase\",\"code\":\"amount\"},{\"scope\":\"EVENT_PROPERTY\",\"eventCode\":\"purchase\",\"code\":\"channel\"}]},
  \"metrics\":[
    {\"alias\":\"amount_sum\",\"eventCode\":\"purchase\",\"field\":{\"scope\":\"EVENT_PROPERTY\",\"eventCode\":\"purchase\",\"code\":\"amount\"},\"aggregation\":\"SUM\"},
    {\"alias\":\"amount_avg\",\"eventCode\":\"purchase\",\"field\":{\"scope\":\"EVENT_PROPERTY\",\"eventCode\":\"purchase\",\"code\":\"amount\"},\"aggregation\":\"AVG\"},
    {\"alias\":\"purchase_count\",\"eventCode\":\"purchase\",\"aggregation\":\"COUNT\"}
  ]
}" 200

# 5.2 Pivot: channel x is_new with SUM, AVG, COUNT
# 注：purchase 事件无 is_new 属性，validator 会拒绝
log "  --- 5.2 Pivot: channel x is_new with SUM, AVG, COUNT ---"
api_call POST /report/analysis/query "{
  \"schemaVersion\":\"1.0\",
  \"appId\":$APP_ID,
  \"analysisType\":\"ATTRIBUTE\",
  \"timezone\":\"UTC\",
  \"timeRange\":{\"startInclusive\":\"2026-07-20T00:00:00Z\",\"endExclusive\":\"2026-07-28T00:00:00Z\"},
  \"attribute\":{
    \"eventCode\":\"purchase\",
    \"fields\":[{\"scope\":\"EVENT_PROPERTY\",\"eventCode\":\"purchase\",\"code\":\"amount\"}],
    \"rowFields\":[{\"scope\":\"EVENT_PROPERTY\",\"eventCode\":\"purchase\",\"code\":\"channel\"}],
    \"columnFields\":[{\"scope\":\"EVENT_PROPERTY\",\"eventCode\":\"purchase\",\"code\":\"is_new\"}]
  },
  \"metrics\":[
    {\"alias\":\"amount_sum\",\"eventCode\":\"purchase\",\"field\":{\"scope\":\"EVENT_PROPERTY\",\"eventCode\":\"purchase\",\"code\":\"amount\"},\"aggregation\":\"SUM\"},
    {\"alias\":\"amount_avg\",\"eventCode\":\"purchase\",\"field\":{\"scope\":\"EVENT_PROPERTY\",\"eventCode\":\"purchase\",\"code\":\"amount\"},\"aggregation\":\"AVG\"},
    {\"alias\":\"purchase_count\",\"eventCode\":\"purchase\",\"aggregation\":\"COUNT\"}
  ]
}" 50310

# 5.3 Error: missing attribute → 40010
log "  --- 5.3 错误：缺少 attribute → 40010 ---"
api_call POST /report/analysis/query "{
  \"schemaVersion\":\"1.0\",
  \"appId\":$APP_ID,
  \"analysisType\":\"ATTRIBUTE\",
  \"timezone\":\"UTC\",
  \"timeRange\":{\"startInclusive\":\"2026-07-20T00:00:00Z\",\"endExclusive\":\"2026-07-28T00:00:00Z\"},
  \"metrics\":[{\"alias\":\"cnt\",\"eventCode\":\"purchase\",\"aggregation\":\"COUNT\"}]
}" 40010

# ─────────────────────────── 六、能力查询（capability） ───────────────────────────
log "=== 六、能力查询（capability） ==="

api_call POST /report/analysis/capability "{\"appId\":$APP_ID,\"analysisType\":\"EVENT\"}" 200
api_call POST /report/analysis/capability "{\"appId\":$APP_ID,\"analysisType\":\"RETENTION\"}" 200
api_call POST /report/analysis/capability "{\"appId\":$APP_ID,\"analysisType\":\"FUNNEL\"}" 200
api_call POST /report/analysis/capability "{\"appId\":$APP_ID,\"analysisType\":\"DISTRIBUTION\"}" 200
api_call POST /report/analysis/capability "{\"appId\":$APP_ID,\"analysisType\":\"ATTRIBUTE\"}" 200

# ─────────────────────────── 七、无效参数校验 ───────────────────────────
log "=== 七、无效参数校验 ==="

# 7.1 Error: invalid analysisType → 50010 (fastjson 反序列化枚举失败)
log "  --- 7.1 错误：无效 analysisType → 50010 ---"
api_call POST /report/analysis/query "{
  \"schemaVersion\":\"1.0\",
  \"appId\":$APP_ID,
  \"analysisType\":\"INVALID_TYPE\",
  \"timezone\":\"UTC\",
  \"timeRange\":{\"startInclusive\":\"2026-07-20T00:00:00Z\",\"endExclusive\":\"2026-07-28T00:00:00Z\"}
}" 50010

# 7.2 Error: invalid schemaVersion → 40010
log "  --- 7.2 错误：无效 schemaVersion → 40010 ---"
api_call POST /report/analysis/query "{
  \"schemaVersion\":\"99.0\",
  \"appId\":$APP_ID,
  \"analysisType\":\"EVENT\",
  \"timezone\":\"Asia/Shanghai\",
  \"timeRange\":{\"startInclusive\":\"2026-07-20T00:00:00+08:00\",\"endExclusive\":\"2026-07-28T00:00:00+08:00\"},
  \"timeGrain\":\"DAY\",
  \"metrics\":[{\"alias\":\"starts\",\"eventCode\":\"app_start\",\"aggregation\":\"COUNT\"}]
}" 40010

# 7.3 Error: inverted timeRange (endExclusive < startInclusive) → 40010
log "  --- 7.3 错误：倒置时间范围 → 40010 ---"
api_call POST /report/analysis/query "{
  \"schemaVersion\":\"1.0\",
  \"appId\":$APP_ID,
  \"analysisType\":\"EVENT\",
  \"timezone\":\"Asia/Shanghai\",
  \"timeRange\":{\"startInclusive\":\"2026-07-28T00:00:00+08:00\",\"endExclusive\":\"2026-07-20T00:00:00+08:00\"},
  \"timeGrain\":\"DAY\",
  \"metrics\":[{\"alias\":\"starts\",\"eventCode\":\"app_start\",\"aggregation\":\"COUNT\"}]
}" 40010

# ─────────────────────────── 总结 ───────────────────────────
log ""
log "=========================================="
log "  分析模块 E2E 结果：PASS=$PASS  FAIL=$FAIL"
log "=========================================="
if [ $FAIL -gt 0 ]; then
    log "失败步骤："
    for s in "${FAILED_STEPS[@]}"; do log "  - $s"; done
    exit 1
fi
log "全部步骤通过 ✓"
exit 0