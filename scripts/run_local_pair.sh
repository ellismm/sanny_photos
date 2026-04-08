#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PYTHON_BIN="$ROOT/env/bin/python"
LOG_DIR="/tmp/sanny-local/logs"

mkdir -p "$LOG_DIR" /tmp/sanny-local/a/images /tmp/sanny-local/b/images

if [ ! -f /tmp/sanny-local/a/album.json ]; then
  cp "$ROOT/album.json" /tmp/sanny-local/a/album.json
fi

if [ ! -f /tmp/sanny-local/b/album.json ]; then
  cp "$ROOT/album.json" /tmp/sanny-local/b/album.json
fi

if [ -d "$ROOT/static/images" ] && [ -z "$(find /tmp/sanny-local/a/images -mindepth 1 -print -quit 2>/dev/null)" ]; then
  cp -a "$ROOT/static/images/." /tmp/sanny-local/a/images/
fi

if [ -d "$ROOT/static/images" ] && [ -z "$(find /tmp/sanny-local/b/images -mindepth 1 -print -quit 2>/dev/null)" ]; then
  cp -a "$ROOT/static/images/." /tmp/sanny-local/b/images/
fi

for pid_file in /tmp/sanny-local/a/app.pid /tmp/sanny-local/b/app.pid; do
  if [ -f "$pid_file" ]; then
    pid="$(cat "$pid_file" 2>/dev/null || true)"
    if [ -n "${pid:-}" ] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      sleep 1
    fi
    rm -f "$pid_file"
  fi
done

nohup env SANNY_ENV_FILE="$ROOT/.env.local-a" "$PYTHON_BIN" "$ROOT/app.py" \
  >"$LOG_DIR/app-a.log" 2>&1 &
echo $! >/tmp/sanny-local/a/app.pid

nohup env SANNY_ENV_FILE="$ROOT/.env.local-b" "$PYTHON_BIN" "$ROOT/app.py" \
  >"$LOG_DIR/app-b.log" 2>&1 &
echo $! >/tmp/sanny-local/b/app.pid

sleep 2

echo "Local pair started."
echo "A: http://127.0.0.1:5102"
echo "B: http://127.0.0.1:5103"
echo
echo "Logs:"
echo "  $LOG_DIR/app-a.log"
echo "  $LOG_DIR/app-b.log"
