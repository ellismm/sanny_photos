#!/usr/bin/env bash
set -euo pipefail

PID_FILE="/tmp/sanny-desktop-test/app.pid"

if [ -f "$PID_FILE" ]; then
  pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [ -n "${pid:-}" ] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
  fi
  rm -f "$PID_FILE"
fi

echo "Desktop test frame stopped."
