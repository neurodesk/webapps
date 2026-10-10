#!/usr/bin/env bash
set -euo pipefail
node "$(dirname "$0")/../../../packages/vesselboost/scripts/verify-preprocessing.mjs"
node "$(dirname "$0")/../../../packages/vesselboost/scripts/stage-browser.mjs"
