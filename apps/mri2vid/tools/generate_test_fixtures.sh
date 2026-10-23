#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

PYTHON="${PYTHON:-python3}"
if [[ -x .venv/bin/python && "$PYTHON" == "python3" ]]; then
  PYTHON=.venv/bin/python
fi

"$PYTHON" tools/gen_phantom.py
"$PYTHON" tools/gen_reference.py
