#!/usr/bin/env bash
# RESEARCH ONLY. Runs the 24-run SamSrfAnalysis matrix (cli_plan.py) through one module on
# both hosts' bundles of the pinned CLI source recording, then holds each against that
# host's MATLAB process with the unmodified compare_web_cli.py.
#
#   run.sh PACKAGE CLI_PINS OUT
#
# PACKAGE is a packages/samsrf directory: this checkout's (the committed module) or one
# build.sh wrote. CLI_PINS is the recording extracted by validation/container/download.py:
# one host at its root and the other under ubuntu-24.04/, each with plan.json, bundle/,
# bundle-sha256.json and source-1/ (a source MATLAB process whose receipts do not attest
# the bundle). The folders are named amd and intel here; account.py refuses the reports
# unless the receipts show MKL's CNR auto branch on an AMD CPU at the root and AVX512_E1
# under ubuntu-24.04/. OUT (new) receives amd-web/, intel-web/ and the comparator reports
# amd.json, intel.json.
# PYTHON names an interpreter with numpy and h5py (requirements-cli.txt).
set -euo pipefail
[[ $# -eq 3 ]] || { echo "usage: $0 PACKAGE CLI_PINS OUT" >&2; exit 2; }
package="$(cd "$1" && pwd)"
pins="$(cd "$2" && pwd)"
out=$3
python="${PYTHON:-python3}"
matlab_dir="$(cd "$(dirname "$0")/../.." && pwd)"
if [[ -e "$out" ]]; then
  echo "$out exists; give a new directory" >&2
  exit 1
fi
mkdir -p "$out"
for host in amd intel; do
  root="$pins"
  [[ "$host" == intel ]] && root="$pins/ubuntu-24.04"
  node "$package/validation/matlab/run_web_matrix.mjs" "$root/plan.json" "$root/bundle" \
    "$root/bundle-sha256.json" "$out/$host-web" > "$out/$host-web.log" 2>&1
  # compare_web_cli.py exits nonzero on a failed or inventory-error run; the report says which.
  # It imports its sibling modules, so the interpreter keeps the script's directory on the path.
  status=0
  "$python" "$matlab_dir/compare_web_cli.py" "$root/plan.json" "$root/bundle-sha256.json" \
    "$out/$host-web" "$root/source-1" "$out/$host.json" --expect source \
    --allow-unattested-source-inputs > "$out/$host.log" 2>&1 || status=$?
  echo "$host: comparator exit $status"
done
