#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PYTHON_BIN="$ROOT/env/bin/python"
STATE_ROOT="/tmp/sanny-desktop-test"
LOG_FILE="$STATE_ROOT/app.log"

mkdir -p "$STATE_ROOT/images"

if [ -f "$STATE_ROOT/app.pid" ]; then
  pid="$(cat "$STATE_ROOT/app.pid" 2>/dev/null || true)"
  if [ -n "${pid:-}" ] && kill -0 "$pid" 2>/dev/null; then
    echo "Desktop test frame already running on PID $pid"
    echo "Open http://127.0.0.1:5102"
    exit 0
  fi
  rm -f "$STATE_ROOT/app.pid"
fi

if [ ! -f "$STATE_ROOT/album.json" ]; then
  if [ -f /tmp/sanny-local/a/album.json ]; then
    cp /tmp/sanny-local/a/album.json "$STATE_ROOT/album.json"
  else
    cp "$ROOT/album.json" "$STATE_ROOT/album.json"
  fi
fi

if [ -z "$(find "$STATE_ROOT/images" -mindepth 1 -print -quit 2>/dev/null)" ]; then
  if [ -d /tmp/sanny-local/a/images ] && [ -n "$(find /tmp/sanny-local/a/images -mindepth 1 -print -quit 2>/dev/null)" ]; then
    cp -a /tmp/sanny-local/a/images/. "$STATE_ROOT/images/"
  elif [ -d "$ROOT/static/images" ]; then
    cp -a "$ROOT/static/images/." "$STATE_ROOT/images/"
  fi
fi

nohup env SANNY_ENV_FILE="$ROOT/.env.desktop-frame" "$PYTHON_BIN" "$ROOT/app.py" \
  >"$LOG_FILE" 2>&1 &
echo $! >"$STATE_ROOT/app.pid"

sleep 2

echo "Desktop test frame started."
echo "URL: http://127.0.0.1:5102"
echo "Log: $LOG_FILE"
