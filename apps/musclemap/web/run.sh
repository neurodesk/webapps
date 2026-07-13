#!/bin/bash
set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${1:-8080}"
echo "=== MuscleMap Development Server ==="
echo "Serving at: http://localhost:$PORT"
echo "Press Ctrl+C to stop"
cd "$SCRIPT_DIR"

# Serve with COOP/COEP headers for SharedArrayBuffer (multi-threaded WASM)
python3 -c "
import http.server, functools

class CORSHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
        self.send_header('Cross-Origin-Embedder-Policy', 'credentialless')
        self.send_header('Cache-Control', 'no-store, max-age=0')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

http.server.HTTPServer(('', $PORT), CORSHandler).serve_forever()
"
