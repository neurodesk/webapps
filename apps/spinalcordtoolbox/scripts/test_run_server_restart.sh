#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WEB_DIR="$ROOT_DIR/web"
PORT="${1:-18082}"
PID_FILE="$WEB_DIR/.dev-server-$PORT.pid"
LOG1="$(mktemp)"
LOG2="$(mktemp)"
HOLD_READY="$(mktemp)"
SERVER1=""
SERVER2=""
HOLD_CONN=""

cleanup() {
  if [[ -n "$SERVER1" ]] && kill -0 "$SERVER1" 2>/dev/null; then
    kill "$SERVER1" 2>/dev/null || true
  fi
  if [[ -n "$SERVER2" ]] && kill -0 "$SERVER2" 2>/dev/null; then
    kill "$SERVER2" 2>/dev/null || true
  fi
  if [[ -n "$HOLD_CONN" ]] && kill -0 "$HOLD_CONN" 2>/dev/null; then
    kill "$HOLD_CONN" 2>/dev/null || true
    wait "$HOLD_CONN" 2>/dev/null || true
  fi
  if [[ -f "$PID_FILE" ]]; then
    pid="$(cat "$PID_FILE")"
    if [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
    fi
    rm -f "$PID_FILE"
  fi
  rm -f "$LOG1" "$LOG2" "$HOLD_READY"
}

wait_for_pid_file() {
  local previous="${1:-}"
  for _ in {1..50}; do
    if [[ -f "$PID_FILE" ]]; then
      pid="$(cat "$PID_FILE")"
      if [[ "$pid" =~ ^[0-9]+$ && "$pid" != "$previous" ]] && kill -0 "$pid" 2>/dev/null; then
        return 0
      fi
    fi
    sleep 0.1
  done
  return 1
}

wait_for_http() {
  for _ in {1..50}; do
    if curl --max-time 2 -fsS "http://127.0.0.1:$PORT/" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.1
  done
  return 1
}

trap cleanup EXIT
rm -f "$PID_FILE"

bash "$WEB_DIR/run.sh" "$PORT" >"$LOG1" 2>&1 &
SERVER1="$!"
if ! wait_for_pid_file; then
  cat "$LOG1"
  echo "First dev server did not start" >&2
  exit 1
fi
PID1="$(cat "$PID_FILE")"

bash "$WEB_DIR/run.sh" "$PORT" >"$LOG2" 2>&1 &
SERVER2="$!"
if ! wait_for_pid_file "$PID1"; then
  cat "$LOG1"
  cat "$LOG2"
  echo "Replacement dev server did not start" >&2
  exit 1
fi
PID2="$(cat "$PID_FILE")"

if kill -0 "$PID1" 2>/dev/null; then
  cat "$LOG1"
  cat "$LOG2"
  echo "Original dev server is still running after replacement" >&2
  exit 1
fi

if ! wait_for_http; then
  cat "$LOG2"
  echo "Replacement dev server is not serving HTTP" >&2
  exit 1
fi

python3 - "$PORT" "$HOLD_READY" <<'PY' &
import pathlib
import socket
import sys
import time

port = int(sys.argv[1])
ready_path = pathlib.Path(sys.argv[2])
sock = socket.create_connection(("127.0.0.1", port), timeout=2)
ready_path.write_text("ready")
try:
    time.sleep(10)
finally:
    sock.close()
PY
HOLD_CONN="$!"

for _ in {1..30}; do
  if [[ -s "$HOLD_READY" ]]; then
    break
  fi
  sleep 0.1
done

if [[ ! -s "$HOLD_READY" ]]; then
  cat "$LOG2"
  echo "Idle connection test did not establish its socket" >&2
  exit 1
fi

if ! curl --max-time 2 -fsS "http://127.0.0.1:$PORT/" >/dev/null 2>&1; then
  cat "$LOG2"
  echo "Dev server did not respond while an idle connection was open" >&2
  exit 1
fi

kill "$HOLD_CONN" 2>/dev/null || true
wait "$HOLD_CONN" 2>/dev/null || true
HOLD_CONN=""

echo "Dev server restart test passed: $PID1 -> $PID2"
