#!/usr/bin/env bash
# Print the current VERSION from web/js/app/config.js. Used by the
# release workflow to compute the next version + tag the build.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONFIG="${ROOT}/web/js/app/config.js"

if [[ ! -f "$CONFIG" ]]; then
  echo "VERSION source not found at ${CONFIG}" >&2
  exit 1
fi

VERSION="$(grep -oE "^export const VERSION = '[^']+';" "$CONFIG" \
  | sed -E "s/^export const VERSION = '(.*)';$/\1/")"

if [[ -z "$VERSION" ]]; then
  echo "Failed to parse VERSION from ${CONFIG}" >&2
  exit 1
fi

printf '%s\n' "$VERSION"
