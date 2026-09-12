#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 2 || $# -gt 3 || ( $# -eq 3 && ${3-} != --no-conform ) ]]; then
  echo 'Usage: capture-openrecon.sh input.nii.gz output-directory [--no-conform]' >&2
  exit 2
fi

input=$(realpath "$1")
output=$(realpath -m "$2")
original_sha=bdb7022ae229c5b8edd16425928c9243c562f84082b9b8e6f97cdba8b9354a98
resampled_sha=69dc5c8be1850422e30ce8b03c6b434bb919c0427a3ec79e79b7552b4c00db5e
image=vnmd/topofit_0.5.1@sha256:dff22ad5577a1a7ba0530759e009f293271ea5ddfc3441fb35b61322bbd6ec29
actual_sha=$(sha256sum "$input" | cut -d ' ' -f 1)
if [[ $actual_sha != "$original_sha" && $actual_sha != "$resampled_sha" ]]; then
  echo "Unexpected validation input SHA-256: $actual_sha" >&2
  exit 1
fi
if [[ $# -eq 3 && $actual_sha != "$resampled_sha" ]]; then
  echo 'The controlled --no-conform case requires the committed browser-resampled fixture.' >&2
  exit 1
fi
mkdir -p "$output"
docker_cli=(docker)
if ! docker info >/dev/null 2>&1; then
  docker_cli=(sudo docker)
fi
"${docker_cli[@]}" pull "$image"
extra_args=()
if [[ $# -eq 3 ]]; then
  extra_args+=(--no-conform)
fi
"${docker_cli[@]}" run --rm --network none --user "$(id -u):$(id -g)" --env USER=topofit --entrypoint topofit-openrecon \
  -v "$(dirname "$input"):/input:ro" \
  -v "$output:/output" \
  "$image" "/input/$(basename "$input")" /output \
  --device cpu --model t1w_1mm --overlay-thickness 0 "${extra_args[@]}"
