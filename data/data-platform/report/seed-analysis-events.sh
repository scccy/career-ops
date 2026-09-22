#!/bin/bash
#=============================================================================
# seed-analysis-events.sh
# 为 app_001 (2077597832956723202) 预置分析事件元数据 + 模拟数据
# 1. MySQL event_center: 事件元数据（幂等）
# 2. Postgres qpointplay_report_analytics: 事件明细 + 聚合 + 快照（幂等）
#=============================================================================

set -euo pipefail

APP_ID="${APP_ID:-2077597832956723202}"
MYSQL_CMD="mysql -h127.0.0.1 -uroot -pRootPass2024 --default-character-set=utf8mb4 qpointplay_event_center"
PG_CMD="docker exec -e PGPASSWORD=asdsc88Q12 sub2api-postgres psql -U sub2api -d qpointplay_report_analytics"
PG_CONTAINER="sub2api-postgres"
PG_SQL_FILE="/tmp/seed_pg_${APP_ID}.sql"

BASE_ID="${APP_ID:0:8}0000000"
EVENT_ID_OFFSET=100; PROPERTY_ID_OFFSET=200; USER_PROPERTY_ID_OFFSET=300
NOW=$(date '+%Y-%m-%d %H:%M:%S')
CREATED_BY="seed-script"

log() { echo "[$(date +%H:%M:%S)] $*"; }

# ═══════════════════════════════════════════════════════════════════════════
# 阶段一：MySQL 事件元数据
# ═══════════════════════════════════════════════════════════════════════════
log "=== 阶段一：MySQL 事件元数据 ==="

EXISTING_COUNT=$(${MYSQL_CMD} -N -e \
    "SELECT COUNT(*) FROM event_metadata WHERE app_id = ${APP_ID} AND del_flag = 0;" 2>/dev/null || echo "0")

if [[ "${EXISTING_COUNT}" -gt 0 ]]; then
    log "  已存在 ${EXISTING_COUNT} 条事件元数据，跳过 MySQL 插入"
else
    log "  插入 event_metadata ..."
    ${MYSQL_CMD} -e "
    INSERT INTO event_metadata (id, app_id, event_name, display_name, description, event_type, created_by, created_time, updated_by, updated_time, del_flag) VALUES
    (${BASE_ID}$((EVENT_ID_OFFSET + 1)), ${APP_ID}, 'app_start', 'APP启动', '应用启动事件', 'track', '${CREATED_BY}', '${NOW}', '${CREATED_BY}', '${NOW}', 0),
    (${BASE_ID}$((EVENT_ID_OFFSET + 2)), ${APP_ID}, 'app_crash', 'APP崩溃', '应用崩溃事件', 'track', '${CREATED_BY}', '${NOW}', '${CREATED_BY}', '${NOW}', 0),
    (${BASE_ID}$((EVENT_ID_OFFSET + 3)), ${APP_ID}, 'register',  '用户注册', '用户注册事件', 'track', '${CREATED_BY}', '${NOW}', '${CREATED_BY}', '${NOW}', 0),
    (${BASE_ID}$((EVENT_ID_OFFSET + 4)), ${APP_ID}, 'activate',  '用户激活', '用户激活事件', 'track', '${CREATED_BY}', '${NOW}', '${CREATED_BY}', '${NOW}', 0),
    (${BASE_ID}$((EVENT_ID_OFFSET + 5)), ${APP_ID}, 'purchase',  '付费事件', '付费行为事件', 'track', '${CREATED_BY}', '${NOW}', '${CREATED_BY}', '${NOW}', 0);
    "
    log "  event_metadata: 5 条完成"
fi

EXISTING_PROPS=$(${MYSQL_CMD} -N -e \
    "SELECT COUNT(*) FROM event_property_metadata WHERE app_id = ${APP_ID} AND del_flag = 0;" 2>/dev/null || echo "0")

if [[ "${EXISTING_PROPS}" -gt 0 ]]; then
    log "  已存在 ${EXISTING_PROPS} 条事件属性，跳过"
else
    log "  插入 event_property_metadata ..."
    PROP_ID=1
    ${MYSQL_CMD} -e "
    INSERT INTO event_property_metadata (id, app_id, event_name, property_name, property_type, required, display_name, attr_type, data_type, created_by, created_time, updated_by, updated_time, del_flag) VALUES
    (${BASE_ID}$((PROPERTY_ID_OFFSET + PROP_ID++)), ${APP_ID}, 'app_start', 'channel', 'string', 0, '渠道', 'attribute', 'STRING', '${CREATED_BY}', '${NOW}', '${CREATED_BY}', '${NOW}', 0),
    (${BASE_ID}$((PROPERTY_ID_OFFSET + PROP_ID++)), ${APP_ID}, 'app_start', 'is_new',  'boolean',0, '是否新用户', 'attribute', 'BOOLEAN', '${CREATED_BY}', '${NOW}', '${CREATED_BY}', '${NOW}', 0),
    (${BASE_ID}$((PROPERTY_ID_OFFSET + PROP_ID++)), ${APP_ID}, 'app_crash', 'screen_height', 'number', 0, '屏幕高度', 'attribute', 'NUMBER', '${CREATED_BY}', '${NOW}', '${CREATED_BY}', '${NOW}', 0),
    (${BASE_ID}$((PROPERTY_ID_OFFSET + PROP_ID++)), ${APP_ID}, 'register',  'channel', 'string', 0, '渠道', 'attribute', 'STRING', '${CREATED_BY}', '${NOW}', '${CREATED_BY}', '${NOW}', 0),
    (${BASE_ID}$((PROPERTY_ID_OFFSET + PROP_ID++)), ${APP_ID}, 'activate',  'channel', 'string', 0, '渠道', 'attribute', 'STRING', '${CREATED_BY}', '${NOW}', '${CREATED_BY}', '${NOW}', 0),
    (${BASE_ID}$((PROPERTY_ID_OFFSET + PROP_ID++)), ${APP_ID}, 'purchase',  'amount',  'number', 0, '付费金额', 'attribute', 'NUMBER', '${CREATED_BY}', '${NOW}', '${CREATED_BY}', '${NOW}', 0),
    (${BASE_ID}$((PROPERTY_ID_OFFSET + PROP_ID++)), ${APP_ID}, 'purchase',  'channel', 'string', 0, '渠道', 'attribute', 'STRING', '${CREATED_BY}', '${NOW}', '${CREATED_BY}', '${NOW}', 0);
    "
    log "  event_property_metadata: 7 条完成"
fi

EXISTING_UPROPS=$(${MYSQL_CMD} -N -e \
    "SELECT COUNT(*) FROM user_property_metadata WHERE app_id = ${APP_ID} AND del_flag = 0;" 2>/dev/null || echo "0")

if [[ "${EXISTING_UPROPS}" -gt 0 ]]; then
    log "  已存在 ${EXISTING_UPROPS} 条用户属性，跳过"
else
    log "  插入 user_property_metadata ..."
    ${MYSQL_CMD} -e "
    INSERT INTO user_property_metadata (id, app_id, property_name, data_type, created_by, created_time, updated_by, updated_time, del_flag) VALUES
    (${BASE_ID}$((USER_PROPERTY_ID_OFFSET + 1)), ${APP_ID}, 'channel', 'STRING', '${CREATED_BY}', '${NOW}', '${CREATED_BY}', '${NOW}', 0),
    (${BASE_ID}$((USER_PROPERTY_ID_OFFSET + 2)), ${APP_ID}, 'name',    'STRING', '${CREATED_BY}', '${NOW}', '${CREATED_BY}', '${NOW}', 0);
    "
    log "  user_property_metadata: 2 条完成"
fi

# ═══════════════════════════════════════════════════════════════════════════
# 阶段二：Postgres 模拟事件数据
# ═══════════════════════════════════════════════════════════════════════════
log "=== 阶段二：Postgres 模拟事件数据 ==="

REVISION=1001
SNAPSHOT_ID="snapshot-e2e-$(date +%Y%m%d)"

# 检查是否已有数据
PG_DWD_COUNT=$(${PG_CMD} -t -c "SELECT COUNT(*) FROM dwd_event_detail WHERE app_id = ${APP_ID};" 2>/dev/null | tr -d ' ' || echo "0")
if [[ "${PG_DWD_COUNT}" -gt 0 ]]; then
    log "  已存在 ${PG_DWD_COUNT} 条 DWD 事件数据，清空后重插"
    ${PG_CMD} -c "DELETE FROM dwd_event_detail WHERE app_id = ${APP_ID};" >/dev/null
    ${PG_CMD} -c "DELETE FROM dws_user_event_day WHERE app_id = ${APP_ID};" >/dev/null
    ${PG_CMD} -c "DELETE FROM dw_published_snapshot WHERE app_id = ${APP_ID};" >/dev/null
fi

log "  插入 dwd_event_detail (近 7 天，10 个用户，5 种事件) ..."

# 生成 7 天数据：2026-07-21 ~ 2026-07-27
# 用户: u1~u10
# 渠道: organic, ad, referral
# 事件逻辑:
#   - register: u1~u5 在 D1, u6~u8 在 D2, u9~u10 在 D3
#   - app_start: 所有用户每天，但并非全部
#   - activate: 注册用户中有 70% 激活
#   - purchase: 付费用户有不同金额
#   - app_crash: 少量随机

log "  写入 SQL 到 ${PG_SQL_FILE} ..."
cat > "${PG_SQL_FILE}" << SQLEOF
ALTER TABLE dw_published_snapshot ADD COLUMN IF NOT EXISTS available_until timestamptz;
ALTER TABLE dw_published_snapshot ADD COLUMN IF NOT EXISTS published_at timestamptz;
ALTER TABLE dw_published_snapshot ADD COLUMN IF NOT EXISTS unavailable_layers TEXT[];

DELETE FROM dwd_event_detail WHERE app_id = ${APP_ID};
DELETE FROM dws_user_event_day WHERE app_id = ${APP_ID};
DELETE FROM dw_published_snapshot WHERE app_id = ${APP_ID};

INSERT INTO dwd_event_detail (app_id, event_key, event_time, event_name, user_id, event_properties, warehouse_revision)
SELECT
  ${APP_ID} AS app_id,
  ('${APP_ID}-' || d::text || '-' || u.user_id || '-' || e.event_name || '-' || (row_number() OVER (PARTITION BY d, u.user_id, e.event_name ORDER BY u.user_id))::text) AS event_key,
  ('2026-07-21'::date + d::int + ((random() * 86400)::int || ' seconds')::interval) AT TIME ZONE 'Asia/Shanghai' AS event_time,
  e.event_name,
  u.user_id,
  CASE e.event_name
    WHEN 'app_start' THEN jsonb_build_object('channel', u.channel, 'is_new', (d=0), 'screen_height', 720 + (random()*360)::int)
    WHEN 'register'  THEN jsonb_build_object('channel', u.channel)
    WHEN 'activate'  THEN jsonb_build_object('channel', u.channel)
    WHEN 'purchase'  THEN jsonb_build_object('channel', u.channel, 'amount', (random()*1000)::int)
    WHEN 'app_crash' THEN jsonb_build_object('screen_height', 720 + (random()*360)::int)
  END AS event_properties,
  1001 AS warehouse_revision
FROM
  generate_series(0, 6) AS d,
  (VALUES ('u1','organic'),('u2','organic'),('u3','ad'),('u4','ad'),('u5','referral'),('u6','organic'),('u7','ad'),('u8','ad'),('u9','referral'),('u10','referral')) AS u(user_id, channel),
  (VALUES ('app_start'),('register'),('activate'),('purchase'),('app_crash')) AS e(event_name)
WHERE
  (e.event_name = 'register' AND (
    (u.user_id IN ('u1','u2','u3','u4','u5') AND d = 0) OR
    (u.user_id IN ('u6','u7','u8') AND d = 1) OR
    (u.user_id IN ('u9','u10') AND d = 2)
  ))
  OR (e.event_name = 'activate' AND random() < 0.7 AND (
    (u.user_id IN ('u1','u2','u3','u4','u5') AND d >= 0) OR
    (u.user_id IN ('u6','u7','u8') AND d >= 1) OR
    (u.user_id IN ('u9','u10') AND d >= 2)
  ))
  OR (e.event_name = 'app_start' AND random() < 0.8)
  OR (e.event_name = 'purchase' AND random() < 0.3)
  OR (e.event_name = 'app_crash' AND random() < 0.05);

INSERT INTO dws_user_event_day (app_id, event_date, event_name, user_id, event_count, first_event_time, last_event_time, warehouse_revision)
SELECT
  app_id, event_time::date, event_name, user_id,
  COUNT(*), MIN(event_time), MAX(event_time), 1001
FROM dwd_event_detail WHERE app_id = ${APP_ID}
GROUP BY app_id, event_time::date, event_name, user_id;

INSERT INTO dw_published_snapshot (app_id, snapshot_id, status, dwd_revision, dws_revision, available_until, published_at)
VALUES (${APP_ID}, '${SNAPSHOT_ID}', 'PUBLISHED', 1001, 1001, '2099-12-31 23:59:59+08'::timestamptz, NOW()::timestamptz)
ON CONFLICT (app_id, snapshot_id) DO UPDATE SET status='PUBLISHED', dwd_revision=1001, dws_revision=1001, available_until='2099-12-31 23:59:59+08'::timestamptz, published_at=NOW()::timestamptz;
SQLEOF

log "  执行 PG SQL ..."
docker cp "${PG_SQL_FILE}" "${PG_CONTAINER}:${PG_SQL_FILE}" >/dev/null 2>&1
${PG_CMD} -f "${PG_SQL_FILE}" >/dev/null 2>&1
rm -f "${PG_SQL_FILE}"

# ═══════════════════════════════════════════════════════════════════════════
# 验证
# ═══════════════════════════════════════════════════════════════════════════
log "=== 验证 ==="
log "  MySQL event_metadata:          $(${MYSQL_CMD} -N -e "SELECT COUNT(*) FROM event_metadata WHERE app_id=${APP_ID} AND del_flag=0;")"
log "  MySQL event_property_metadata: $(${MYSQL_CMD} -N -e "SELECT COUNT(*) FROM event_property_metadata WHERE app_id=${APP_ID} AND del_flag=0;")"
log "  MySQL user_property_metadata:  $(${MYSQL_CMD} -N -e "SELECT COUNT(*) FROM user_property_metadata WHERE app_id=${APP_ID} AND del_flag=0;")"
log "  PG dwd_event_detail:           $(${PG_CMD} -t -c "SELECT COUNT(*) FROM dwd_event_detail WHERE app_id=${APP_ID};" | tr -d ' ')"
log "  PG dws_user_event_day:         $(${PG_CMD} -t -c "SELECT COUNT(*) FROM dws_user_event_day WHERE app_id=${APP_ID};" | tr -d ' ')"
log "  PG snapshot:                   $(${PG_CMD} -t -c "SELECT snapshot_id FROM dw_published_snapshot WHERE app_id=${APP_ID};" | tr -d ' ')"

log "=== 种子数据完成 ==="