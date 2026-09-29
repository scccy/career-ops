#!/usr/bin/env bash
# boss-extract-3cities.sh — 地点×岗位词 笛卡尔积提取
# 单一来源 = config/profile.yml：
#   boss.daily_extract_cities × (每城关键词 boss.daily_extract_keywords_by_city[城市]，否则回退 boss.daily_extract_queries)
# 词表顺序即优先级：前 3 个为主关键词(main 轮)，其余为补充关键词(all 轮)
#
# 前置：BOSS Chrome 已启动（双击图标即可，自带 9222 调试端口）
# 用法：
#   bash boss-extract-3cities.sh                 # 主关键词轮：每城前 3 词
#   bash boss-extract-3cities.sh --all          # 主+补充轮：每城全部词
#   bash boss-extract-3cities.sh --city 杭州     # 只扫描杭州（主轮），不影响其他城
#   bash boss-extract-3cities.sh --city 杭州 --all

set -e
cd "$(dirname "$0")"

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

# 若指定 --city，只跑该城（隔离扫描，不动其他城）
if [ -n "$CITY" ]; then
  CITY_ARR=("$CITY")
fi

MAIN_COUNT=3   # 主关键词数 = 词表前 3 个

city_code() {
  node -e 'import("./boss-common.mjs").then(m => console.log(m.BOSS_CITY_CODES[process.argv[1]] || ""))' "$1"
}

# 取某城的搜索关键词：优先每城独立词表（数据库），否则回退全局统一词表（数据库）
city_keywords() {
  node -e '
  (async () => {
    const { loadBossControl } = await import("./boss-config-db.mjs");
    const cfg = await loadBossControl().catch(() => ({}));
    const kw = cfg.daily_extract_keywords_by_city || {};
    const list = (kw[process.argv[1]] && kw[process.argv[1]].length) ? kw[process.argv[1]] : (cfg.daily_extract_queries || []);
    console.log(list.join("\t"));
  })();
  ' "$1"
}

extract_one() {
  local name="$1" code="$2" query="$3" company_limit="$4" max_cards="$5"
  local enc; enc=$(node -e 'console.log(encodeURIComponent(process.argv[1]))' "$query")
  echo ""
  echo "=== [$name] 提取中（query=$query, city=$code, company-limit=$company_limit）==="
  node boss-cdp.mjs --goto "https://www.zhipin.com/web/geek/jobs?query=${enc}&city=${code}"
  sleep 3
  npm run boss:chrome:extract -- --company-limit "$company_limit" --max-cards "$max_cards" --click-gap-ms 1800 --append
  sleep 5   # 轮间隔，降低风控压力
}

for city in "${CITY_ARR[@]}"; do
  code=$(city_code "$city")
  if [ -z "$code" ]; then echo "⚠ 未知城市 [$city]，跳过（可在 boss-common.mjs BOSS_CITY_CODES 补城市码，或在 profile.yml daily_extract_cities 加入）"; continue; fi
  # 该城关键词：优先每城独立词表，否则全局词表
  IFS=$'\t' read -r -a CITY_QUERIES <<< "$(city_keywords "$city")"
  [ "${#CITY_QUERIES[@]}" -eq 0 ] && CITY_QUERIES=("${QUERY_ARR[@]}")
  # 主轮：词表前 MAIN_COUNT 个
  for ((i = 0; i < MAIN_COUNT && i < ${#CITY_QUERIES[@]}; i++)); do
    extract_one "$city" "$code" "${CITY_QUERIES[$i]}" 40 200
  done
  # 补充轮：其余词（仅 --all）
  if [ "$MODE" = "all" ]; then
    for ((i = MAIN_COUNT; i < ${#CITY_QUERIES[@]}; i++)); do
      extract_one "$city" "$code" "${CITY_QUERIES[$i]}" 30 120
    done
  fi
done

echo ""
echo "=== 提取完成，评分 + 强制过滤（校招/实习/外包/已发送）==="
npm run boss:score -- --input data/boss-candidates.json
node boss-filter-queue.mjs
echo ""
echo "=== 完成。下一步：npm run boss:review 生成确认清单，人工确认后才可发送 ==="
