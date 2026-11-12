#!/usr/bin/env bash
# Run `matlab -batch COMMAND` in the builder container on this host.
# build_container.py calls it through SAMSRF_MATLAB_BATCH.
#
# Required environment:
#   SAMSRF_MATLAB_ROOT  mpm install of R2023b Update 11 (mounted read-only at /opt/matlab)
#   SAMSRF_LICENSE      license file for this host (mounted read-only), or a
#                       network license server as PORT@HOST
#   SAMSRF_WORK         work directory (mounted at the same path)
#   SAMSRF_BUILDER      builder image ID (licensed-host/Dockerfile)
# Optional:
#   SAMSRF_INPUT        read-only bundle mounted at /input
#
# --network host keeps this host's network identity, which a host-locked license
# checks. The Docker socket lets MATLAB Compiler build its Runtime and app images.
set -euo pipefail
[ "$#" -eq 1 ] || { echo 'Usage: matlab_batch.sh MATLAB_COMMAND' >&2; exit 2; }
repo="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
arguments=(--rm --network host --init
  --user "$(id -u):$(id -g)" --group-add "$(stat -c %g /var/run/docker.sock)"
  --volume /etc/passwd:/etc/passwd:ro --volume /etc/group:/etc/group:ro
  --env "USER=$(id -un)" --env "HOME=$SAMSRF_WORK/home"
  --volume "$SAMSRF_MATLAB_ROOT:/opt/matlab:ro"
  --volume /var/run/docker.sock:/var/run/docker.sock
  --volume "$SAMSRF_WORK:$SAMSRF_WORK" --volume "$repo:$repo:ro"
  --workdir "$PWD")
for name in MKL_CBWR MKL_NUM_THREADS OMP_NUM_THREADS MKL_DYNAMIC OMP_DYNAMIC; do
  arguments+=(--env "$name=${!name:-}")
done
if [[ "$SAMSRF_LICENSE" =~ ^[0-9]+@[A-Za-z0-9.-]+$ ]]; then
  arguments+=(--env "MLM_LICENSE_FILE=$SAMSRF_LICENSE")
else
  arguments+=(--env MLM_LICENSE_FILE=/licenses/license.lic
    --volume "$SAMSRF_LICENSE:/licenses/license.lic:ro")
fi
if [ -n "${SAMSRF_INPUT:-}" ]; then
  arguments+=(--volume "$SAMSRF_INPUT:/input:ro")
fi
mkdir -p "$SAMSRF_WORK/home"
exec docker run "${arguments[@]}" "$SAMSRF_BUILDER" /opt/matlab/bin/matlab -batch "$1"
