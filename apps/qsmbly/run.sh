#!/bin/bash
# Serve QSMbly locally at http://localhost:8080
#
# Usage:
#   ./run.sh                 # http://localhost:8080
#   ./run.sh 9000            # another port
#   ./run.sh 8080 0.0.0.0    # also reachable from other machines on the network
#
# Delegates to serve.py, which sends the COOP/COEP headers threaded WASM needs and
# disables caching so a rebuilt bundle is always picked up.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

cd "$SCRIPT_DIR"
exec python3 serve.py "$@"
