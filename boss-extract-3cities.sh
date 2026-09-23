#!/usr/bin/env bash
# boss-extract-3cities.sh — 按 config/profile.yml boss.daily_extract_queries 多城多关键词提取
# 关键词单一来源 = profile.yml（每城第 1 个为主关键词，其余为补充关键词），城市自动含 无锡/常州
#
# 前置：BOSS Chrome 已启动（双击图标即可，自带 9222 调试端口）
# 用法：
#   bash boss-extract-3cities.sh            # 只跑每城主关键词（--company-limit 40 --max-cards 200）
#   bash boss-extract-3cities.sh --all      # 主关键词 + 补充关键词（补充轮 --company-limit 30 --max-cards 120）

set -e
cd "$(dirname "$0")"

if ! curl -s --max-time 3 http://127.0.0.1:9222/json/version >/dev/null 2>&1; then
  echo "✗ 9222 不通：请先双击 Chrome 图标启动（或 npm run boss:chrome:start）"
  exit 1
fi

MODE="${1:-main}"   # main | all
if [ "$MODE" != "main" ] && [ "$MODE" != "all" ]; then
  echo "用法: bash boss-extract-3cities.sh [main|all]"; exit 1
fi

# 从 profile.yml 读 城市<TAB>关键词... 表（daily_extract_queries 的唯一消费方）
mapfile -t ROWS < <(node -e '
const yaml = require("js-yaml");
const fs = require("fs");
const q = (yaml.load(fs.readFileSync("config/profile.yml", "utf-8")) || {}).boss?.daily_extract_queries || {};
if (!Object.keys(q).length) { console.error("config/profile.yml 缺少 boss.daily_extract_queries"); process.exit(1); }
for (const [city, kws] of Object.entries(q)) console.log([city, ...kws].join("\t"));
')

city_code() {
  node -e 'import("./boss-common.mjs").then(m => console.log(m.BOSS_CITY_CODES[process.argv[1]] || ""))' "$1"
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

for row in "${ROWS[@]}"; do
  IFS=$'\t' read -r -a cols <<< "$row"
  city="${cols[0]}"
  code=$(city_code "$city")
  if [ -z "$code" ]; then echo "⚠ 未知城市 [$city]，跳过（可在 boss-common.mjs BOSS_CITY_CODES 补城市码）"; continue; fi
  # 主关键词 = 第 1 个
  extract_one "$city" "$code" "${cols[1]}" 40 200
  # 补充关键词 = 第 2..N 个（仅 --all）
  if [ "$MODE" = "all" ]; then
    for ((i = 2; i < ${#cols[@]}; i++)); do
      extract_one "$city" "$code" "${cols[$i]}" 30 120
    done
  fi
done

echo ""
echo "=== 提取完成，评分 + 强制过滤（校招/实习/外包/已发送）==="
npm run boss:score -- --input data/boss-candidates.json
node boss-filter-queue.mjs
echo ""
echo "=== 完成。下一步：npm run boss:review 生成确认清单，人工确认后才可发送 ==="
