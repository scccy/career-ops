#!/usr/bin/env bash
# boss-extract-3cities.sh — 地点×岗位词 笛卡尔积提取
# 单一来源 = config/profile.yml：
#   boss.daily_extract_cities × (每城关键词 boss.daily_extract_keywords_by_city[城市]，否则回退 boss.daily_extract_queries)
# 词表顺序即优先级：前 3 个为主关键词(main 轮)，其余为补充关键词(all 轮)
#
# 前置：BOSS Chrome 已启动（双击图标即可，自带 9222 调试端口）
# 用法：
#   bash boss/boss-extract-3cities.sh            # 主关键词轮：每城前 3 词
#   bash boss/boss-extract-3cities.sh --all      # 主+补充轮：每城全部词
#   bash boss/boss-extract-3cities.sh --city 杭州 # 只扫描杭州（主轮），不影响其他城
#   bash boss/boss-extract-3cities.sh --city 杭州 --all
#   bash boss/boss-extract-3cities.sh --city 杭州 --keywords "大数据开发,数仓"  # 只扫指定关键词（控制台多选下拉用）
#
# 节奏节流（均可环境变量覆盖，打破多城连续扫描的风控信号）：
#   BOSS_KEYWORD_GAP_SECONDS  单城内关键词之间的休息秒数（默认 300 = 5 分钟）
#   BOSS_CITY_GAP_SECONDS     城市之间的休息秒数（默认 600 = 10 分钟，0 = 关闭冷却）
#   BOSS_SCAN_BUDGET_FACTOR   单城扫描预算系数（默认 1.3）：单城收的公司数 ≈ 该城每日投递上限 × 系数，按词均分；避免过度扫描

set -e
# 脚本位于 boss/ 子目录；所有 data/、config/ 路径与 npm scripts 均以仓库根为 CWD
cd "$(dirname "$0")/.."

if ! curl -s --max-time 3 http://127.0.0.1:9222/json/version >/dev/null 2>&1; then
  echo "✗ 9222 不通：请先双击 Chrome 图标启动（或 npm run boss:chrome:start）"
  exit 1
fi

# ---- 参数解析 ----
MODE="main"
CITY=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --city) CITY="$2"; shift 2;;
    --all)  MODE="all";  shift;;
    --main) MODE="main"; shift;;
    --keywords) KW_OVERRIDE="$2"; shift 2;;
    main|all) MODE="$1"; shift;;
    *) shift;;
  esac
done

# 从 profile.yml 读城市列表与全局词表
mapfile -t ROWS < <(node -e '
const yaml = require("js-yaml");
const fs = require("fs");
const boss = (yaml.load(fs.readFileSync("config/profile.yml", "utf-8")) || {}).boss || {};
const cities = boss.daily_extract_cities || [];
const queries = boss.daily_extract_queries || [];
if (!cities.length || !queries.length) { console.error("config/profile.yml 缺少 boss.daily_extract_cities / daily_extract_queries"); process.exit(1); }
console.log("CITIES\t" + cities.join("\t"));
console.log("QUERIES\t" + queries.join("\t"));
')
IFS=$'\t' read -r -a CITY_ARR <<< "${ROWS[0]#CITIES$'\t'}"
IFS=$'\t' read -r -a QUERY_ARR <<< "${ROWS[1]#QUERIES$'\t'}"

# 显式关键词子集（控制台多选下拉）：逗号分隔，仅与 --city 搭配使用
KW_ARR=()
if [ -n "$KW_OVERRIDE" ]; then
  if [ -z "$CITY" ]; then echo "✗ --keywords 必须配合 --city 使用"; exit 1; fi
  IFS=',' read -r -a KW_ARR <<< "$KW_OVERRIDE"
  MAIN_COUNT=${#KW_ARR[@]}
fi

# 若指定 --city，只跑该城（隔离扫描，不动其他城）
if [ -n "$CITY" ]; then
  CITY_ARR=("$CITY")
fi

KEYWORD_GAP="${BOSS_KEYWORD_GAP_SECONDS:-300}"   # 关键词之间休息秒数，默认 5 分钟（用户要求 2026-10-01）
CITY_GAP="${BOSS_CITY_GAP_SECONDS:-600}"          # 城市之间休息秒数，默认 10 分钟（用户要求 2026-10-08：打破 5 城连续无间断扫描的风控信号）；0 = 关闭冷却

MAIN_COUNT=3   # 主关键词数 = 词表前 3 个

city_code() {
  node -e 'import("./boss/boss-common.mjs").then(m => console.log(m.BOSS_CITY_CODES[process.argv[1]] || ""))' "$1"
}

# 取某城的搜索关键词：优先每城独立词表（数据库），否则回退全局统一词表（数据库）
city_keywords() {
  node -e '
  (async () => {
    const { loadBossControl } = await import("./boss/boss-config-db.mjs");
    const cfg = await loadBossControl().catch(() => ({}));
    const kw = cfg.daily_extract_keywords_by_city || {};
    const list = (kw[process.argv[1]] && kw[process.argv[1]].length) ? kw[process.argv[1]] : (cfg.daily_extract_queries || []);
    console.log(list.join("\t"));
  })();
  ' "$1"
}

# 取某城每日投递上限（投递上线）：优先 DB boss_config.daily_limit_per_city，否则回退 profile.yml；未配置或 ≤0 返回空
city_quota() {
  node -e '
  (async () => {
    const { loadBossControl } = await import("./boss/boss-config-db.mjs");
    const cfg = await loadBossControl().catch(() => ({}));
    const m = (cfg.daily_limit_per_city && typeof cfg.daily_limit_per_city === "object") ? cfg.daily_limit_per_city : {};
    const q = m[process.argv[1]];
    console.log((typeof q === "number" && q > 0) ? q : "");
  })();
  ' "$1"
}

extract_one() {
  local name="$1" code="$2" query="$3" company_limit="$4" max_cards="$5"
  local enc; enc=$(node -e 'console.log(encodeURIComponent(process.argv[1]))' "$query")
  echo ""
  echo "=== [$name] 提取中（query=$query, city=$code, company-limit=$company_limit）==="
  node boss/boss-cdp.mjs --goto "https://www.zhipin.com/web/geek/jobs?query=${enc}&city=${code}"
  sleep 3
  npm run boss:chrome:extract -- --company-limit "$company_limit" --max-cards "$max_cards" --click-gap-ms 1800 --append
}

# 关键词之间休息（用户要求 2026-10-01：默认 5 分钟，可用 BOSS_KEYWORD_GAP_SECONDS 覆盖）
keyword_gap() {
  echo "（关键词间隔休息 ${KEYWORD_GAP}s，降低风控压力…）"
  sleep "$KEYWORD_GAP"
}

# 城市之间休息（用户要求 2026-10-08：默认 10 分钟，可用 BOSS_CITY_GAP_SECONDS 覆盖；0 = 不休息）
city_gap() {
  [ "${CITY_GAP:-0}" -le 0 ] && return
  echo "（城市间隔休息 ${CITY_GAP}s，降低风控压力…）"
  sleep "$CITY_GAP"
}

city_idx=0
for city in "${CITY_ARR[@]}"; do
  city_idx=$((city_idx+1))
  [ "$city_idx" -gt 1 ] && city_gap   # 第 2 城起先休息再扫，避免多城连续扫描
  code=$(city_code "$city")
  if [ -z "$code" ]; then echo "⚠ 未知城市 [$city]，跳过（可在 boss-common.mjs BOSS_CITY_CODES 补城市码，或在 profile.yml daily_extract_cities 加入）"; continue; fi
  # 该城关键词：显式子集优先（--keywords），否则每城独立词表，再否则全局词表
  if [ "${#KW_ARR[@]}" -gt 0 ]; then
    CITY_QUERIES=("${KW_ARR[@]}")
  else
    IFS=$'\t' read -r -a CITY_QUERIES <<< "$(city_keywords "$city")"
    [ "${#CITY_QUERIES[@]}" -eq 0 ] && CITY_QUERIES=("${QUERY_ARR[@]}")
  fi
  # ---- 单城扫描量绑定该城每日投递上限（投递上线）----
  # 避免过度扫描：单城收的公司数 ≈ 配额 × 系数（BOSS_SCAN_BUDGET_FACTOR，默认 1.3 留过滤余量），按该城生效词数均分到每词。
  # 配额未配置或为 0 时回退遗留固定值（主轮 40/200，补充轮 30/120），行为不变。
  CITY_QUOTA=$(city_quota "$city")
  if [ -n "$CITY_QUOTA" ]; then
    FACTOR="${BOSS_SCAN_BUDGET_FACTOR:-1.3}"
    CITY_BUDGET=$(node -e 'const f=Number(process.argv[2])||1.3; console.log(Math.max(1, Math.round(Number(process.argv[1])*f)))' "$CITY_QUOTA" "$FACTOR")
    NUM_KW="${#CITY_QUERIES[@]}"; [ "$NUM_KW" -lt 1 ] && NUM_KW=1
    PER_KW=$(node -e 'console.log(Math.max(1, Math.round(Number(process.argv[1])/Number(process.argv[2]))))' "$CITY_BUDGET" "$NUM_KW")
    MAIN_LIMIT=$PER_KW; MAIN_MAX=$((PER_KW*5))
    SUPP_LIMIT=$PER_KW; SUPP_MAX=$((PER_KW*5))
    echo "（$city 投递上线 ${CITY_QUOTA}/日 → 扫描预算 ≈ ${CITY_BUDGET} 家，按 ${NUM_KW} 词均分 ≈ ${PER_KW} 家/词）"
  else
    MAIN_LIMIT=40; MAIN_MAX=200
    SUPP_LIMIT=30; SUPP_MAX=120
  fi
  # 主轮：词表前 MAIN_COUNT 个
  for ((i = 0; i < MAIN_COUNT && i < ${#CITY_QUERIES[@]}; i++)); do
    [ "$i" -gt 0 ] && keyword_gap
    extract_one "$city" "$code" "${CITY_QUERIES[$i]}" "$MAIN_LIMIT" "$MAIN_MAX"
  done
  # 补充轮：其余词（仅 --all）——第一词前也休息（紧跟主轮最后一个词之后）
  if [ "$MODE" = "all" ]; then
    for ((i = MAIN_COUNT; i < ${#CITY_QUERIES[@]}; i++)); do
      keyword_gap
      extract_one "$city" "$code" "${CITY_QUERIES[$i]}" "$SUPP_LIMIT" "$SUPP_MAX"
    done
  fi
done

echo ""
echo "=== 提取完成，评分 + 强制过滤（校招/实习/外包/已发送）==="
npm run boss:score -- --input data/boss-candidates.json
node boss/boss-filter-queue.mjs
echo ""
echo "=== 完成。下一步：npm run boss:review 生成确认清单，人工确认后才可发送 ==="
