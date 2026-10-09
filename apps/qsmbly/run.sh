#!/bin/bash
# Serve QSMbly locally
# Opens a development server at http://localhost:8080

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${1:-8080}"

echo "=== QSMbly Development Server ==="
echo ""
echo "Serving at: http://localhost:$PORT"
echo "Press Ctrl+C to stop"
echo ""

cd "$SCRIPT_DIR"
python3 -m http.server "$PORT"
