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

  echo "Stopping existing CALMaR dev server on port $PORT (pid $pid)"
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
    if [[ "$cwd" == "$SCRIPT_DIR" && "$command" == *"http.server.HTTPServer"* ]]; then
      stop_pid "$pid"
    fi
  done
}

stop_existing_server

# Phase 40: write a build-info.json so the orchestrator can show the
# current commit SHA + branch + dirty flag in the version badge.
# Production + staging deploys write their own build-info.json from
# .github/workflows/; local dev writes it here on each server start.
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
if git -C "$REPO_ROOT" rev-parse --short HEAD >/dev/null 2>&1; then
  SHA="$(git -C "$REPO_ROOT" rev-parse --short HEAD)"
  BRANCH="$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD)"
  if git -C "$REPO_ROOT" diff-index --quiet HEAD -- 2>/dev/null; then
    DIRTY=false
  else
    DIRTY=true
  fi
  cat > "$SCRIPT_DIR/build-info.json" <<EOF
{
  "sha": "${SHA}",
  "branch": "${BRANCH}",
  "dirty": ${DIRTY},
  "buildEnv": "local"
}
EOF
fi

echo "=== CALMaR Development Server ==="
echo "Serving at: http://localhost:$PORT"
echo "Press Ctrl+C to stop"
cd "$SCRIPT_DIR"

# Serve with COOP/COEP headers for SharedArrayBuffer (multi-threaded WASM)
python3 -c "
import http.server, json, os, threading, time, urllib.parse

DOWNLOADS = {}
DOWNLOAD_LOCK = threading.Lock()
DOWNLOAD_TTL_SECONDS = 600
MAX_DOWNLOAD_BYTES = 256 * 1024 * 1024
DOWNLOAD_DIR = os.path.expanduser('~/Downloads')
if not os.path.isdir(DOWNLOAD_DIR):
    DOWNLOAD_DIR = os.path.join(os.getcwd(), 'downloads')
os.makedirs(DOWNLOAD_DIR, exist_ok=True)

def prune_downloads():
    now = time.time()
    for key, item in list(DOWNLOADS.items()):
        if item['expires'] < now:
            del DOWNLOADS[key]

def safe_filename_from_path(path):
    name = os.path.basename(urllib.parse.unquote(path.rstrip('/').split('/')[-1]))
    if not name:
        name = 'lnm-mask.nii'
    return ''.join(ch if ch.isalnum() or ch in '._-' else '_' for ch in name)

class CORSHandler(http.server.SimpleHTTPRequestHandler):
    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        if not parsed.path.startswith('/__lnm_downloads/'):
            self.send_error(404, 'Not found')
            return

        try:
            length = int(self.headers.get('Content-Length', '0') or '0')
        except ValueError:
            self.send_error(400, 'Invalid Content-Length')
            return
        if length <= 0:
            self.send_error(400, 'Empty download payload')
            return
        if length > MAX_DOWNLOAD_BYTES:
            self.send_error(413, 'Download payload too large')
            return

        data = self.rfile.read(length)
        if len(data) != length:
            self.send_error(400, 'Incomplete download payload')
            return

        filename = safe_filename_from_path(parsed.path)
        with DOWNLOAD_LOCK:
            prune_downloads()
            DOWNLOADS[parsed.path] = {
                'data': data,
                'filename': filename,
                'expires': time.time() + DOWNLOAD_TTL_SECONDS,
            }
        stage_only = self.headers.get('X-LNM-Stage-Only') == '1'
        output_path = None
        if not stage_only:
            output_path = os.path.join(DOWNLOAD_DIR, filename)
            tmp_path = '{}.tmp-{}-{}'.format(output_path, os.getpid(), threading.get_ident())
            with open(tmp_path, 'wb') as f:
                f.write(data)
            os.replace(tmp_path, output_path)
        payload = json.dumps({
            'url': parsed.path,
            'saved': not stage_only,
            **({'savedPath': output_path} if output_path else {}),
            'byteLength': len(data),
        }).encode('utf-8')
        self.send_response(201)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path.startswith('/__lnm_downloads/'):
            with DOWNLOAD_LOCK:
                prune_downloads()
                item = DOWNLOADS.get(parsed.path)
            if not item:
                self.send_error(404, 'Download expired')
                return
            data = item['data']
            filename = item['filename']
            self.send_response(200)
            self.send_header('Content-Type', 'application/octet-stream')
            self.send_header('Content-Disposition', 'attachment; filename=\"{}\"'.format(filename))
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            self.close_connection = True
            return
        return super().do_GET()

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
