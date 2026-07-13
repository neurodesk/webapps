#!/bin/bash
set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${1:-8080}"

PID_FILE="$SCRIPT_DIR/.dev-server-$PORT.pid"

stop_pid() {
  local pid="$1"
  if ! kill -0 "$pid" 2>/dev/null; then
    return 0
  fi

  echo "Stopping existing SCT dev server on port $PORT (pid $pid)"
  kill "$pid" 2>/dev/null || true
  for _ in {1..20}; do
    if ! kill -0 "$pid" 2>/dev/null; then
      return 0
    fi
    sleep 0.1
  done

  echo "Existing dev server did not stop cleanly; forcing shutdown (pid $pid)"
  kill -9 "$pid" 2>/dev/null || true
}

stop_existing_server() {
  if [[ -f "$PID_FILE" ]]; then
    local pid
    pid="$(cat "$PID_FILE")"
    if [[ "$pid" =~ ^[0-9]+$ ]]; then
      stop_pid "$pid"
    fi
    rm -f "$PID_FILE"
  fi

  if ! command -v lsof >/dev/null 2>&1; then
    return 0
  fi

  local pids pid cwd command
  pids="$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"
  for pid in $pids; do
    cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n1)"
    command="$(ps -p "$pid" -o command= 2>/dev/null || true)"
    if [[ "$cwd" == "$SCRIPT_DIR" && "$command" == *"http.server."*"HTTPServer"* ]]; then
      stop_pid "$pid"
    fi
  done
}

stop_existing_server

echo "=== SCT Browser Segmentation Development Server ==="
echo "Serving at: http://localhost:$PORT"
echo "Press Ctrl+C to stop"
cd "$SCRIPT_DIR"

# Serve with COOP/COEP headers for SharedArrayBuffer (multi-threaded WASM)
python3 -c "
import http.server, functools

class CORSHandler(http.server.SimpleHTTPRequestHandler):
    def send_head(self):
        for header in ('If-Modified-Since', 'If-None-Match'):
            if header in self.headers:
                del self.headers[header]
        return super().send_head()

    def end_headers(self):
        self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
        self.send_header('Cross-Origin-Embedder-Policy', 'credentialless')
        self.send_header('Cache-Control', 'no-store, must-revalidate')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

http.server.ThreadingHTTPServer(('', $PORT), CORSHandler).serve_forever()
" &
SERVER_PID="$!"
echo "$SERVER_PID" > "$PID_FILE"

cleanup() {
  if kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  if [[ -f "$PID_FILE" && "$(cat "$PID_FILE")" == "$SERVER_PID" ]]; then
    rm -f "$PID_FILE"
  fi
}

trap cleanup EXIT INT TERM
wait "$SERVER_PID"
