#!/bin/bash
# 在前台启动工作台，终端 Ctrl+C 停止。
cd "$(dirname "$0")" || exit 1

url="http://localhost:5177/"
if curl -fsS --max-time 1 "$url" 2>/dev/null | grep -Fq '<title>K-Overlay-Studio</title>'; then
  exec open "$url"
fi

exec npm run dev -- --open
