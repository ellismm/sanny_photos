#!/usr/bin/env bash
set -euo pipefail

for pid_file in /tmp/sanny-local/a/app.pid /tmp/sanny-local/b/app.pid; do
  if [ -f "$pid_file" ]; then
    pid="$(cat "$pid_file" 2>/dev/null || true)"
    if [ -n "${pid:-}" ] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
    fi
    rm -f "$pid_file"
  fi
done

echo "Local pair stopped."
