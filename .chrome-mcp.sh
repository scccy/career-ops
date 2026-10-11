#!/bin/bash
# 启动 chrome-devtools-mcp，连接日常 Windows Chrome
# 经 WSL 镜像网络 + /mnt/c 读取 DevToolsActivePort，自动拼出 wsEndpoint
export PATH="/opt/lan/node/v26/bin:$PATH"
UD="/mnt/c/Users/scccy/AppData/Local/Google/Chrome/User Data"
PORT_FILE="$UD/DevToolsActivePort"
if [ ! -f "$PORT_FILE" ]; then
  echo "未找到 $PORT_FILE" >&2
  echo "请先在日常 Chrome 打开 chrome://inspect/#remote-debugging 并打开远程调试开关" >&2
  exit 1
fi
PORT=$(sed -n '1p' "$PORT_FILE" | tr -d '\r')
BPATH=$(sed -n '2p' "$PORT_FILE" | tr -d '\r')
WS="ws://127.0.0.1:${PORT}${BPATH}"
exec npx -y chrome-devtools-mcp@latest --wsEndpoint "$WS" "$@"
