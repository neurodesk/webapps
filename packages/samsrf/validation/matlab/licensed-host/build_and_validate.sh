#!/usr/bin/env bash
# Build the compiled SamSrfAnalysis reference on one licensed Linux host and run
# every gate of samsrf-native's runtime_cli=build mode on that same host:
# source MATLAB twice, the custom-HRF check, the compiled image twice, strict
# compiled-versus-source and repeat comparisons, interruption and failure.
# Nothing is published; publish the reported image ID separately once it passes.
#
# Usage: build_and_validate.sh NEW_WORK_DIRECTORY LICENSE_FILE_OR_PORT@HOST MATLAB_ROOT
#   MATLAB_ROOT is an mpm install of R2023bU11 with MATLAB_Compiler,
#   Statistics_and_Machine_Learning_Toolbox, Image_Processing_Toolbox and
#   Parallel_Computing_Toolbox. The license must cover MATLAB Compiler.
set -euo pipefail
[ "$#" -eq 3 ] || { sed -n '2,12p' "$0" >&2; exit 2; }
here="$(cd "$(dirname "$0")" && pwd)"
matlab="$(dirname "$here")"
repo="$(git -C "$here" rev-parse --show-toplevel)"
work="$1"
[ ! -e "$work" ] || { echo "$work exists; use a new directory" >&2; exit 2; }
grep -q '<version>23.2.0.3097123</version>' "$3/VersionInfo.xml" \
  || { echo "$3 is not MATLAB 23.2.0.3097123 (R2023b Update 11)" >&2; exit 2; }
mkdir -p "$work"
work="$(cd "$work" && pwd)"
export SAMSRF_WORK="$work"
if [[ "$2" =~ ^[0-9]+@ ]]; then
  export SAMSRF_LICENSE="$2"
else
  export SAMSRF_LICENSE="$(cd "$(dirname "$2")" && pwd)/$(basename "$2")"
fi
export SAMSRF_MATLAB_ROOT="$(cd "$3" && pwd)"
export MKL_CBWR=COMPATIBLE MKL_NUM_THREADS=1 OMP_NUM_THREADS=1 MKL_DYNAMIC=FALSE OMP_DYNAMIC=FALSE
source_commit="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["commit"])' "$matlab/source.json")"
spm_commit="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["spm"]["commit"])' "$matlab/source.json")"
cli="$work/samsrf-cli"
mkdir -p "$cli"
cd "$work"

# The exact sources, as the workflow checks them out (SPM: root files and three classes).
git clone --quiet https://github.com/samsrf/samsrf.git reference-source
git -C reference-source checkout --quiet "$source_commit"
git clone --quiet --filter=blob:none --sparse https://github.com/spm/spm12.git reference-spm
git -C reference-spm sparse-checkout set @gifti @xmltree @file_array
git -C reference-spm checkout --quiet "$spm_commit"
python3 "$repo/packages/samsrf/validation/container/download.py" "$work/matrix-input" "$matlab/inputs.json"
python3 "$matlab/prepare.py" --cli reference-source "$cli/provenance"
python3 "$matlab/cli_plan.py" plan "$cli/plan.json"
docker build --quiet --tag samsrf-matlab-builder:r2023b "$here" > /dev/null
export SAMSRF_BUILDER="$(docker image inspect samsrf-matlab-builder:r2023b --format '{{.Id}}')"
# The comparator's pinned wheels target CI's Python; use the builder's 3.10 (as ubuntu-22.04).
in_builder() {
  docker run --rm --user "$(id -u):$(id -g)" --env HOME="$work/home" \
    --volume "$work:$work" --volume "$repo:$repo:ro" --workdir "$work" "$SAMSRF_BUILDER" "$@"
}
mkdir -p "$work/home"
in_builder python3 -m venv "$work/venv"
in_builder "$work/venv/bin/pip" install --quiet --only-binary=:all: -r "$matlab/requirements-cli.txt"
compare() { in_builder "$work/venv/bin/python" "$matlab/compare_cli.py" "$@"; }
matlab_string() {
  local value="${1//\'/\'\'}"
  printf "'%s'" "$value"
}
run_matlab() {
  local function_name="$1"
  shift
  local command="addpath($(matlab_string "$matlab")); $function_name("
  local separator="" argument
  for argument in "$@"; do
    command+="$separator$(matlab_string "$argument")"
    separator=,
  done
  "$here/matlab_batch.sh" "$command)"
}

# 1. MATLAB Compiler build (build_container.py verifies the CLI repair set and pins).
SAMSRF_MATLAB_BATCH="$here/matlab_batch.sh" \
  python3 "$matlab/build_container.py" reference-source reference-spm "$cli/container-build"

# 2. The shared read-only bundle, prepared once in source MATLAB.
run_matlab prepare_cli_bundle "$work/reference-source" "$work/reference-spm" "$work/matrix-input" "$cli/bundle" "$cli/plan.json"
python3 "$matlab/cli_plan.py" models "$cli/plan.json" "$cli/bundle"
python3 "$matlab/cli_plan.py" hash "$cli/bundle" "$cli/bundle-sha256.json"
chmod -R a-w "$cli/bundle"
export SAMSRF_INPUT="$cli/bundle"
for run in source-1 source-2 compiled-1 compiled-2 interrupt; do
  python3 "$matlab/cli_plan.py" stage "$cli/plan.json" "$cli/bundle" "$cli/$run"
done
python3 "$matlab/capture_environment.py" "$cli/source-1"
python3 "$matlab/capture_environment.py" "$cli/source-2"

# 3. Source MATLAB on this host: two processes and the custom-HRF check.
run_matlab run_source_cli "$work/reference-source" "$work/reference-spm" "$cli/plan.json" "$cli/source-1"
run_matlab verify_cli_hrf "$work/reference-source" "$work/reference-spm" "$cli/plan.json" "$cli/source-1" "$cli/source-1-direct"
run_matlab run_source_cli "$work/reference-source" "$work/reference-spm" "$cli/plan.json" "$cli/source-2"
python3 "$matlab/cli_plan.py" verify "$cli/bundle" "$cli/bundle-sha256.json"
compare "$cli/plan.json" "$cli/source-1" "$cli/source-2" "$cli/source-repeat.json"

# 4. The compiled image on the same host, without MATLAB, network or writable inputs.
image="$(docker image inspect samsrf-reference:41ed1e96-r2023b --format '{{.Id}}')"
python3 "$matlab/run_runtime_cli.py" run "$image" "$cli/plan.json" "$cli/bundle" "$cli/compiled-1"
python3 "$matlab/run_runtime_cli.py" run "$image" "$cli/plan.json" "$cli/bundle" "$cli/compiled-2"
compare "$cli/plan.json" "$cli/source-1" "$cli/compiled-1" "$cli/compiled-vs-source.json"
compare "$cli/plan.json" "$cli/compiled-1" "$cli/compiled-2" "$cli/compiled-repeat.json"
longest="$(python3 -c 'import json,pathlib,sys; r=[json.loads(p.read_text()) for p in pathlib.Path(sys.argv[1]).glob("*.json") if p.name not in ("environment.json","inputs.json")]; m=max(r,key=lambda x:x["seconds"]); print(m["id"], max(10, m["seconds"]/2))' "$cli/compiled-1/receipts")"
python3 "$matlab/run_runtime_cli.py" interrupt "$image" "$cli/plan.json" "$cli/bundle" "$cli/interrupt" $longest
mkdir -p "$cli/failure/missing-model"
cp "$cli/bundle/SamSrf_defaults.json" "$cli/failure/missing-model/"
python3 "$matlab/run_runtime_cli.py" failure "$image" "$cli/bundle" "$cli/failure/missing-model"
echo "All gates passed on this host for local image $image."
echo "Evidence: $cli. Publish this image ID by digest; it has not been pushed."
