#!/bin/bash
set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${1:-8080}"
echo "=== SeedSeg Development Server ==="
echo "Serving at: http://localhost:$PORT"
echo "Press Ctrl+C to stop"
cd "$SCRIPT_DIR"

# coi-serviceworker.js handles COOP/COEP for SharedArrayBuffer
python3 -m http.server $PORT
