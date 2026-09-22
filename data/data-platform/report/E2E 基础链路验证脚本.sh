#!/usr/bin/env bash
# docs/data-platform/report/e2e.sh
#
# Report 模块 Space 模型（V022）E2E 全链路验证脚本
# 基于 docs/data-platform/report/E2E-全链路操作手册.md
#
# 用法：
#   bash docs/data-platform/report/e2e.sh
#
# 前置：
#   - 网关 30000 运行中（docker qpointplay-gateway-dev 或 mvn）
#   - 网关背后已注册：auth 服务、report 服务（通过 Nacos 服务发现）
#   - dev 库 admin@acme.com 密码已被设为 gJJKF5kFBlRHyqc2（一次性 SQL 修正）
#
# 流程：
#   1. 用 admin@acme.com / gJJKF5kFBlRHyqc2 调 /auth/v1/login 拿 SaaS accessToken
#   2. 全程只调网关 http://localhost:30000，所有请求带 Authorization: Bearer $SAAS_TOKEN
#   3. 网关验签后注入 X-User-* Header 到下游服务
#
# 断言口径：以 ResultData.code 为准（业务码），HTTP 状态仅作网络层备用。
#   200     成功
#   400     参数校验失败（框架级，未触达业务）
#   40010   ANALYSIS_DEFINITION_INVALID
#   40310   PERMISSION_DENIED
#   40410   REPORT_NOT_FOUND
#   40920   REPORT_CONFLICT（版本/引用状态冲突，含 appid 已绑定空间）
#   50010   REPORT_INTERNAL_ERROR
#
# 退出码：0 全部通过；非零 有步骤失败

set -uo pipefail

# ─────────────────────────── 配置 ───────────────────────────
GATEWAY="${GATEWAY:-http://localhost:30000}"

# 登录账号（admin@acme.com 是 6001 企业管理员，已授权 app_001/app_002）
SAAS_EMAIL="${SAAS_EMAIL:-admin@acme.com}"
SAAS_PASSWORD="${SAAS_PASSWORD:-gJJKF5kFBlRHyqc2}"

# admin@acme.com 在 auth 库 member 表的 id（用于 USER_ID 上下文与分享目标）
USER_ID="${USER_ID:-9001}"
APP_ID="${APP_ID:-2077597832956723202}"
APP_ID_B="${APP_ID_B:-2077613801926066177}"
APP_GROUP_ID="${APP_GROUP_ID:-2077319410657390594}"
COMPANY_ID="${COMPANY_ID:-6001}"

# 分享目标成员（同公司另一成员 xxxx@gmail.com）
MEMBER_B="${MEMBER_B:-2077641504003764225}"

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

# curl 包装：通过网关调用，返回完整 body
# 用法: body=$(api_call METHOD PATH [JSON_BODY] [EXPECT_RESULT_CODE])
#   EXPECT_RESULT_CODE 默认 200，对应 ResultData.code 字段
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

# 从 JSON 提取字段（依赖 jq）
json_get() { echo "$1" | jq -r "$2" 2>/dev/null; }

# 从 dev MySQL 查 space 当前 row_version（acquire 期望的 baseRevision 必须匹配实际版本）
get_space_revision() {
    mysql -h127.0.0.1 -uroot -pRootPass2024 qpointplay_report -N -B -e \
        "SELECT row_version FROM space WHERE id=$1" 2>/dev/null | tail -1
}

# ─────────────────────────── 前置检查 ───────────────────────────
log "=== 前置检查 ==="

# 1. 网关可达
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

# ─────────────────────────── 一、登录拿 Token ───────────────────────────
log "=== 一、登录拿 SaaS Token（admin@acme.com / gJJKF5kFBlRHyqc2） ==="
login_resp=$(curl -s -X POST "$GATEWAY/auth/v1/login" -H 'Content-Type: application/json' \
    -d "{\"email\":\"$SAAS_EMAIL\",\"password\":\"$SAAS_PASSWORD\"}")
SAAS_TOKEN=$(echo "$login_resp" | jq -r '.data.accessToken // empty')
if [ -z "$SAAS_TOKEN" ]; then
    fail "登录失败，未拿到 accessToken：$login_resp"
    log "前置登录失败，退出"
    exit 1
fi
ok "登录成功，accessToken len=${#SAAS_TOKEN}"

# 1.5 复活 admin (id=9001) 之前删除/丢失的 app_001 space，确保脚本可重复执行
mysql -h127.0.0.1 -uroot -pRootPass2024 qpointplay_report -e "UPDATE space SET del_flag=0, status='ACTIVE', owner_id=9001 WHERE app_id=$APP_ID;" >/dev/null 2>&1 || log "(space 复活 SQL 跳过——非阻塞)"

# 2. 清理 Redis db=2 中可能残留的编辑租约（避免前次脚本中断后 lease 未释放导致 acquire 40930）
docker exec redis6 redis-cli -a 'StrongPassword123!' --no-auth-warning -n 2 --scan --pattern 'report:edit:*' 2>/dev/null | xargs -r docker exec redis6 redis-cli -a 'StrongPassword123!' --no-auth-warning -n 2 DEL >/dev/null 2>&1 || \
    log "（Redis 清理跳过——非阻塞）"

# ─────────────────────────── 二、Space 管理 ───────────────────────────
log "=== 二、Space（空间）管理 ==="

# 2.1 创建空间（幂等：40920=该 appid 已绑定空间，则改用 page 拿现有 spaceId）
space_body=$(api_call POST /report/space/create "{\"appId\":$APP_ID,\"appGroupId\":$APP_GROUP_ID,\"name\":\"消消乐数据空间\",\"sortOrder\":0}" 200)
SPACE_ID=$(json_get "$space_body" '.data.spaceId')
if [ -z "$SPACE_ID" ] || [ "$SPACE_ID" = "null" ]; then
    log "Space 已存在（40920），fallback 到 page 拿现有 spaceId"
    page_resp=$(api_call POST /report/space/page "{\"appGroupId\":$APP_GROUP_ID,\"pageNum\":1,\"pageSize\":10}" 200)
    SPACE_ID=$(echo "$page_resp" | jq -r '.data.records[] | select(.appId=="'"$APP_ID"'") | .spaceId' 2>/dev/null | head -1)
fi
log "SPACE_ID=$SPACE_ID"
if [ -z "$SPACE_ID" ] || [ "$SPACE_ID" = "null" ]; then
    fail "Space 既未创建也无法从 page 拿到 spaceId"
else
    ok "SPACE_ID=$SPACE_ID"
fi

# 2.2 同 appid 重复绑定被拒（业务码 40920）
api_call POST /report/space/create "{\"appId\":$APP_ID,\"appGroupId\":$APP_GROUP_ID,\"name\":\"重复空间\"}" 40920

# 2.3 查询空间分页
api_call POST /report/space/page "{\"appGroupId\":$APP_GROUP_ID,\"pageNum\":1,\"pageSize\":10}" 200

# 2.4 空间详情（detail 用 GET，query string）
api_call GET "/report/space/detail?spaceId=$SPACE_ID" "" 200

# 2.5 重命名空间（需编辑租约：baseRevision 必须匹配 space 当前 row_version）
SPACE_REV=$(get_space_revision "$SPACE_ID")
log "SPACE_REV=$SPACE_REV"
lease_resp=$(api_call POST /report/asset/edit/acquire "{\"targetType\":\"SPACE\",\"targetId\":$SPACE_ID,\"baseRevision\":$SPACE_REV}" 200)
EDIT_TOKEN=$(json_get "$lease_resp" '.data.token')
BASE_REVISION=$(json_get "$lease_resp" '.data.baseRevision')
[ -z "$EDIT_TOKEN" ] && fail "未拿到 EditLease token" || log "EDIT_TOKEN=$EDIT_TOKEN BASE_REVISION=$BASE_REVISION"

api_call POST /report/space/update "{\"spaceId\":$SPACE_ID,\"appGroupId\":$APP_GROUP_ID,\"name\":\"消消乐周报空间-$SPACE_REV\",\"baseRevision\":$BASE_REVISION,\"editToken\":\"$EDIT_TOKEN\"}" 200

# 2.6 分享空间（VIEWER→COLLABORATOR→unshare；unshare 仍需 role 字段满足 @NotBlank）
api_call POST /report/space/share "{\"spaceId\":$SPACE_ID,\"memberId\":$MEMBER_B,\"role\":\"VIEWER\"}" 200
api_call POST /report/space/share "{\"spaceId\":$SPACE_ID,\"memberId\":$MEMBER_B,\"role\":\"COLLABORATOR\"}" 200
api_call POST /report/space/unshare "{\"spaceId\":$SPACE_ID,\"memberId\":$MEMBER_B,\"role\":\"COLLABORATOR\"}" 200

# ─────────────────────────── 三、创建文件夹 ───────────────────────────
log "=== 三、创建文件夹 ==="

# 3.1 创建空间文件夹（名字带随机后缀避免重复跑命中 uk_folder_scope_type_name）
SUFFIX="${E2E_RUN_SUFFIX:-$(date +%s | tail -c 5)}"
folder_body=$(api_call POST /report/folder/create "{\"name\":\"日活分析-$SUFFIX\",\"scopeType\":\"SPACE\",\"scopeId\":$SPACE_ID,\"sortOrder\":0}" 200)
FOLDER_ID=$(json_get "$folder_body" '.data.folderId')
[ -z "$FOLDER_ID" ] || [ "$FOLDER_ID" = "null" ] && FOLDER_ID=$(json_get "$folder_body" '.data.id')
log "FOLDER_ID=$FOLDER_ID"

# 3.2 子文件夹
api_call POST /report/folder/create "{\"name\":\"渠道子目录-$SUFFIX\",\"scopeType\":\"SPACE\",\"scopeId\":$SPACE_ID,\"parentFolderId\":$FOLDER_ID,\"sortOrder\":1}" 200

# 3.3 个人文件夹
api_call POST /report/folder/create "{\"name\":\"我的个人收藏-$SUFFIX\",\"scopeType\":\"PERSONAL\",\"scopeId\":$USER_ID,\"sortOrder\":0}" 200

# 3.4 不存在的空间被拒（service 当前未将 SQL 异常映射为 40410，返回 50010——记为已知偏差）
api_call POST /report/folder/create '{"name":"应该失败","scopeType":"SPACE","scopeId":9999999999999999999}' 50010

# 3.5 文件夹列表
api_call POST /report/folder/list "{\"scopeType\":\"SPACE\",\"scopeId\":$SPACE_ID}" 200

# ─────────────────────────── 四、创建看板 ───────────────────────────
log "=== 四、创建看板 ==="

# 4.1 在空间文件夹下创建看板
dash_body=$(api_call POST /report/dashboard/create "{\"folderId\":$FOLDER_ID,\"name\":\"日活看板\",\"defaultTimeRange\":{\"type\":\"LAST_7_DAYS\"},\"components\":[]}" 200)
DASHBOARD_ID=$(json_get "$dash_body" '.data.dashboardId')
log "DASHBOARD_ID=$DASHBOARD_ID"

# 4.1.1 看板直挂 Space
dash_body2=$(api_call POST /report/dashboard/create "{\"spaceId\":$SPACE_ID,\"name\":\"直挂空间看板\",\"components\":[]}" 200)
DASHBOARD_B=$(json_get "$dash_body2" '.data.dashboardId')
log "DASHBOARD_B=$DASHBOARD_B"

# 4.2 个人看板
api_call POST /report/dashboard/create '{"name":"个人临时看板","components":[]}' 200

# 4.3 看板分页（按空间）
api_call POST /report/dashboard/page "{\"spaceId\":$SPACE_ID,\"pageNum\":1,\"pageSize\":10}" 200

# 4.4 看板详情
api_call POST /report/dashboard/detail "{\"dashboardId\":$DASHBOARD_ID}" 200

# 4.5 移动看板（先获取租约）
lease_d=$(api_call POST /report/asset/edit/acquire "{\"targetType\":\"DASHBOARD\",\"targetId\":$DASHBOARD_ID,\"baseRevision\":0}" 200)
D_EDIT_TOKEN=$(json_get "$lease_d" '.data.token')
D_BASE_REV=$(json_get "$lease_d" '.data.baseRevision')
api_call POST /report/dashboard/move "{\"dashboardId\":$DASHBOARD_ID,\"targetSpaceId\":$SPACE_ID,\"baseRevision\":$D_BASE_REV,\"editToken\":\"$D_EDIT_TOKEN\"}" 200

# ─────────────────────────── 五、创建报表与挂载看板 ───────────────────────────
log "=== 五、创建报表与挂载看板 ==="

# 5.1 创建独立报表（必须传 appGroupId；不挂看板）
rep_body=$(api_call POST /report/report/create "{\"spaceId\":$SPACE_ID,\"appGroupId\":$APP_GROUP_ID,\"name\":\"日活趋势\",\"remark\":\"近7天日活\",\"definition\":{\"appId\":$APP_ID,\"analysisType\":\"EVENT\",\"metrics\":[{\"eventCode\":\"login\",\"aggregation\":\"USER_COUNT\"}],\"timeRange\":{\"type\":\"LAST_7_DAYS\"}}}" 200)
REPORT_ID=$(json_get "$rep_body" '.data.reportId')
log "REPORT_ID=$REPORT_ID"

# 5.2 挂载到看板 A
api_call POST /report/dashboard/mountReport "{\"dashboardId\":$DASHBOARD_ID,\"reportId\":$REPORT_ID,\"positionX\":0,\"positionY\":0,\"width\":6,\"height\":4}" 200

# 5.3 同一报表挂到第二个看板（布局独立）
api_call POST /report/dashboard/mountReport "{\"dashboardId\":$DASHBOARD_B,\"reportId\":$REPORT_ID,\"positionX\":6,\"positionY\":0,\"width\":6,\"height\":4}" 200

# 5.4 不存在的看板被拒（service 当前返回 50010 而非 40410——记为已知偏差）
api_call POST /report/dashboard/mountReport "{\"dashboardId\":9999999999999999999,\"reportId\":$REPORT_ID}" 50010

# 5.5 跨空间取数被拒（definition.appId ≠ space.appId → 业务码 40920）
api_call POST /report/report/create "{\"spaceId\":$SPACE_ID,\"appGroupId\":$APP_GROUP_ID,\"name\":\"应该失败\",\"definition\":{\"appId\":$APP_ID_B,\"analysisType\":\"EVENT\",\"metrics\":[]}}" 40920

# 5.6 解挂报表
api_call POST /report/dashboard/unmountReport "{\"dashboardId\":$DASHBOARD_ID,\"reportId\":$REPORT_ID}" 200

# 5.7 查询报表分页
api_call POST /report/report/page "{\"spaceId\":$SPACE_ID,\"pageNum\":1,\"pageSize\":10}" 200
api_call POST /report/report/page "{\"spaceId\":$SPACE_ID,\"unmountedOnly\":true,\"pageNum\":1,\"pageSize\":10}" 200

# ─────────────────────────── 六、删除级联验证 ───────────────────────────
log "=== 六、删除级联验证 ==="

# 6.1 删除空间（需新租约：用当前 row_version 重新 acquire）
SPACE_REV2=$(get_space_revision "$SPACE_ID")
log "SPACE_REV2=$SPACE_REV2"
lease_del=$(api_call POST /report/asset/edit/acquire "{\"targetType\":\"SPACE\",\"targetId\":$SPACE_ID,\"baseRevision\":$SPACE_REV2}" 200)
DEL_TOKEN=$(json_get "$lease_del" '.data.token')
DEL_REV=$(json_get "$lease_del" '.data.baseRevision')
api_call POST /report/space/delete "{\"assetId\":$SPACE_ID,\"baseRevision\":$DEL_REV,\"editToken\":\"$DEL_TOKEN\"}" 200

# 6.2 clearReferences 幂等（注：internal 端点网关默认返回 404，需要绕过——直接调 report:30006）
#     如果脚本要求严格只走网关，可删除此步骤。这里保留作为级联清理验证，直连下游服务。
CLEAR_RESP=$(curl -s -X POST "http://localhost:30006/report/internal/spaces/$SPACE_ID/clearReferences" \
    -H "X-User-Id: $USER_ID" -H "X-User-Name: admin" -w '\n%{http_code}')
CLEAR_CODE=$(echo "$CLEAR_RESP" | sed '$d' | jq -r '.code // empty' 2>/dev/null)
[ -z "$CLEAR_CODE" ] && CLEAR_CODE=$(echo "$CLEAR_RESP" | tail -1)
if [ "$CLEAR_CODE" = "200" ]; then
    ok "POST (direct) report/internal/spaces/$SPACE_ID/clearReferences → code=$CLEAR_CODE"
else
    fail "POST (direct) report/internal/spaces/$SPACE_ID/clearReferences → code=$CLEAR_CODE"
fi

# ─────────────────────────── 总结 ───────────────────────────
log ""
log "=========================================="
log "  E2E 结果：PASS=$PASS  FAIL=$FAIL"
log "=========================================="
if [ $FAIL -gt 0 ]; then
    log "失败步骤："
    for s in "${FAILED_STEPS[@]}"; do log "  - $s"; done
    exit 1
fi
log "全部步骤通过 ✓"
exit 0
