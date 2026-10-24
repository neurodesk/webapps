#!/usr/bin/env bash
# Copy one subject's reference from the run host, without the upstream -t scratch.
#
# Usage: collect.sh <host> <remote run dir>/<subject> <local dest>
# Example:
#   collect.sh epic scratch/bison/runs/ref/sub-HML0541 "$SCRATCH/native/sub-HML0541"
set -euo pipefail
host=$1
src=$2
dst=$3
mkdir -p "$dst"
rsync -a --exclude 'tmp/' --exclude 'logs.*' "$host:$src/" "$dst/"
rsync -a "$host:$src/logs.*" "$dst/logs/" 2>/dev/null || true
