#!/usr/bin/env bash
# boss-chrome-start.sh — 启动 BOSS 自动化专用 Chrome（CDP 9222）
#
# 为什么需要独立数据目录：Chrome 136+ 禁止在默认数据目录开启远程调试端口
# （"DevTools remote debugging requires a non-default data directory"），
# 符号链接绕过也会被路径解析识破。这是本机 Google Chrome 153 的硬限制。
#
# 用法：npm run boss:chrome:start
# 登录：首次启动后在该窗口登录 BOSS 直聘（登录态持久保存在该数据目录）。
# 注意：本机已配置用户级 .desktop 覆盖（~/.local/share/applications/google-chrome.desktop），
#       双击图标即带 9222 端口，本脚本作为兜底/显式启动入口。

set -u
DIR="$HOME/.config/google-chrome-boss"

if curl -s --max-time 2 http://127.0.0.1:9222/json/version >/dev/null 2>&1; then
  echo "OK: BOSS Chrome already running (CDP 9222 ready, data dir: $DIR)"
  exit 0
fi

setsid nohup google-chrome \
  --user-data-dir="$DIR" \
  --remote-debugging-port=9222 \
  --no-first-run \
  --no-default-browser-check \
  --window-size=1400,950 \
  >/tmp/chrome-boss.log 2>&1 < /dev/null &

for i in $(seq 1 10); do
  sleep 1
  if curl -s --max-time 2 http://127.0.0.1:9222/json/version >/dev/null 2>&1; then
    echo "OK: BOSS Chrome launched, CDP 9222 ready (data dir: $DIR)"
    echo "  If not logged into BOSS, log in at this window first."
    exit 0
  fi
done

echo "FAIL: launch failed, see /tmp/chrome-boss.log"
exit 1
