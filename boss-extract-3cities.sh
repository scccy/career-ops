#!/usr/bin/env bash
# boss-extract-3cities.sh — 三城各补 10 家公司提取（2026-09-22 用户要求）
# 上海×大数据开发 / 杭州×数仓 / 南京×数据开发，完成后自动评分+强制过滤
#
# 前置：BOSS Chrome 已启动（双击图标即可，自带 9222 调试端口）
# 用法：bash boss-extract-3cities.sh

set -e
cd "$(dirname "$0")"

if ! curl -s --max-time 3 http://127.0.0.1:9222/json/version >/dev/null 2>&1; then
  echo "✗ 9222 不通：请先双击 Chrome 图标启动（或 npm run boss:chrome:start）"
  exit 1
fi

extract_city() {
  local name="$1" code="$2" query_enc="$3"
  echo ""
  echo "=== [$name] 提取中（query=$query_enc, city=$code）==="
  node boss-cdp.mjs --goto "https://www.zhipin.com/web/geek/jobs?query=${query_enc}&city=${code}"
  sleep 3
  npm run boss:chrome:extract -- --company-limit 10 --max-cards 60 --click-gap-ms 1800 --append
  sleep 5   # 城市间隔，降低风控压力
}

extract_city "上海" "101020100" "%E5%A4%A7%E6%95%B0%E6%8D%AE%E5%BC%80%E5%8F%91"   # 大数据开发
extract_city "杭州" "101210100" "%E6%95%B0%E4%BB%93"                              # 数仓
extract_city "南京" "101190100" "%E6%95%B0%E6%8D%AE%E5%BC%80%E5%8F%91"            # 数据开发

echo ""
echo "=== 提取完成，评分 + 强制过滤（校招/实习/外包/已发送）==="
npm run boss:score -- --input data/boss-candidates.json --threshold 4.0
node boss-filter-queue.mjs
echo ""
echo "=== 完成。下一步：npm run boss:review 生成确认清单，人工确认后才可发送 ==="
