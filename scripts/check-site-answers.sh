#!/usr/bin/env bash
# The landing page probe: fails unless a site's URL answers below HTTP 400.
# deploy-workers and the Pages deploy run it after each publish, and every job
# that checks a site runs it among its checks. These are the base workflow's
# curl flags, unchanged, plus a 30 second deadline per try (--max-time).
#
#   bash scripts/check-site-answers.sh <site URL>
set -euo pipefail
exec curl --fail --silent --show-error --retry 10 --retry-all-errors --retry-delay 15 --max-time 30 --output /dev/null "${1:?usage: check-site-answers.sh <site URL>}"
