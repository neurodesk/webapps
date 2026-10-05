#!/usr/bin/env bash
set -euo pipefail

stage="${1:-all}"
case "$stage" in
  native|webgpu|probe|extraction|catalog|all) ;;
  -h|--help) echo 'Usage: verify-scientific-macos.sh [native|webgpu|probe|extraction|catalog|all]'; exit 0 ;;
  *) echo 'Usage: verify-scientific-macos.sh [native|webgpu|probe|extraction|catalog|all]' >&2; exit 2 ;;
esac
if [[ "$(uname -s)" != Darwin || "$(uname -m)" != arm64 ]]; then
  echo 'This helper requires a native arm64 shell on Apple silicon. See SCIENTIFIC-VALIDATION.md for Linux CPU commands.' >&2
  exit 2
fi
root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"
: "${TMPDIR:?Set TMPDIR to a writable scratch volume.}"
for tool in node pnpm unzip; do
  command -v "$tool" >/dev/null || { printf 'Install %s before running this helper.\n' "$tool" >&2; exit 2; }
done
validation="$(mktemp -d "${TMPDIR%/}/neurodesk-scientific.XXXXXX")"
evidence="$root/scripts/desktop/scientific-evidence.mjs"
export SYNTHSEG_REFERENCE_DIR="${SYNTHSEG_REFERENCE_DIR:-$validation/references}"
export SYNTHSEG_ASSET_DIR="$root/exes/synthseg/models"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$validation/native-target}"
export CI=1
fixtures="${NEURODESK_SCIENTIFIC_FIXTURES:-${TMPDIR%/}/neurodesk-scientific-fixtures}"
fixtures="$(node --input-type=module -e 'import {resolve} from "node:path"; console.log(resolve(process.argv[1]))' "$fixtures")"
printf '%s\n' "$validation" > "$validation/evidence-directory.txt"
git rev-parse HEAD > "$validation/commit.txt"
git status --short > "$validation/worktree.txt"
printf 'Evidence directory: %s\n' "$validation"
node "$evidence" init "$validation" "$stage"
cp packages/synthseg/model.manifest.json "$validation/synthseg-model-manifest.json"
cp packages/topofit/model.manifest.json "$validation/topofit-model-manifest.json"
cp pnpm-lock.yaml "$validation/pnpm-lock.yaml"

native_report='exes/synthseg/validation/report.json'
restore_native_report=0
original_native_report=0
finish() {
  local status=$?
  trap - EXIT
  set +e
  if [[ "$restore_native_report" == 1 ]]; then
    [[ ! -f "$native_report" ]] || cp "$native_report" "$validation/native-parity.json"
    if [[ "$original_native_report" == 1 ]]; then
      cp "$validation/native-report-before.json" "$native_report"
    else
      rm -f "$native_report"
    fi
  fi
  node "$evidence" finish "$validation" "$status"
  local evidence_status=$?
  if [[ "$status" == 0 && "$evidence_status" != 0 ]]; then status=$evidence_status; fi
  printf '%s\n' "$status" > "$validation/exit-code.txt"
  printf 'Evidence directory: %s (exit %s)\n' "$validation" "$status"
  exit "$status"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

run_stage() {
  local name="$1"
  shift
  node "$evidence" status "$validation" "$name" running
  "$@" 2>&1 | tee "$validation/$name.log"
  node "$evidence" status "$validation" "$name" completed
}

native() {
  make -C exes/synthseg check-model fetch-validation
  RUSTUP_TOOLCHAIN=stable SYNTHSEG_REAL_DEVICES=cpu,metal make -C exes/synthseg test test-real
  cp "$native_report" "$validation/native-parity.json"
  node "$evidence" check-synthseg native "$validation/native-parity.json"
  NEURODESK_SYNTHSEG_BIN="$CARGO_TARGET_DIR/release/synthseg" NEURODESK_SCIENTIFIC_OUTPUT="$validation/native-automation" \
    node scripts/desktop/native-scientific-smoke.mjs 2>&1 | tee "$validation/native-automation.log"
  node "$evidence" check-synthseg native-automation "$validation/native-automation/validation.json"
}

probe() {
  SYNTHSEG_PROBE_ONLY=1 NEURODESK_HARDWARE_GPU=1 SYNTHSEG_VALIDATION_REPORT="$validation/webgpu-probe.json" PLAYWRIGHT_JSON_OUTPUT_NAME="$validation/probe-tests.json" \
    pnpm --filter synthseg exec playwright test e2e/fixture.spec.js --headed --grep 'records the WebGPU adapter and planned buffer limits$' --reporter=line,json --retries=0
  node "$evidence" check-playwright "$validation/probe-tests.json" 'records the WebGPU adapter and planned buffer limits'
  node "$evidence" check-synthseg probe "$validation/webgpu-probe.json"
}

webgpu() {
  if [[ "$stage" == webgpu ]]; then
    export SYNTHSEG_ASSET_DIR="$validation/models"
    mkdir -p "$SYNTHSEG_ASSET_DIR"
    make -C exes/synthseg MODEL="$SYNTHSEG_ASSET_DIR/synthseg-2.0.onnx" check-model fetch-validation
  else
    make -C exes/synthseg check-model fetch-validation
  fi
  SYNTHSEG_PROBE_ONLY= SYNTHSEG_E2E_FIXTURE=1 NEURODESK_HARDWARE_GPU=1 SYNTHSEG_VALIDATION_REPORT="$validation/webgpu.json" PLAYWRIGHT_JSON_OUTPUT_NAME="$validation/webgpu-tests.json" \
    pnpm --filter synthseg exec playwright test e2e/fixture.spec.js --headed --reporter=line,json --retries=0
  node "$evidence" check-playwright "$validation/webgpu-tests.json" \
    'records the WebGPU adapter and planned buffer limits' \
    'segments the small fixture in fast mode against the FreeSurfer golden' \
    'segments the small fixture in default mode against the FreeSurfer golden' \
    'segments the benchmark volumes within the native parity gate'
  node "$evidence" check-synthseg webgpu "$validation/webgpu.json"
}

extraction() {
  pnpm --filter brain-extraction build 2>&1 | tee "$validation/extraction-build.log"
  BRAIN_EXTRACTION_REAL_MODELS=1 PLAYWRIGHT_JSON_OUTPUT_NAME="$validation/extraction.json" \
    pnpm --filter brain-extraction exec playwright test --grep 'real model' --reporter=line,json --retries=0
  node "$evidence" check-playwright "$validation/extraction.json" \
    'mindgrab real model returns a nonempty binary mask in input geometry' \
    'synthstrip real model returns a nonempty binary mask in input geometry'
}

catalog() {
  rustup run nightly-2025-11-15 rustc --version
  rustup run nightly-2025-11-15 wasm-pack --version
  node "$evidence" prepare-catalog "$fixtures" "$validation"
  export DWI2TRX_FIXTURE_DIR="$fixtures/dwi2trx"
  export SYNCRO_AUTOMATION_IMAGE="$fixtures/syncro/sub-101_T1w.nii.gz"
  export TOPOFIT_AUTOMATION_IMAGE="$fixtures/topofit/sub-01_T1w.nii.gz"
  local app config title
  for app in brain2print dwi2trx syncro topofit; do
    config="$(node "$evidence" config "$app" "$validation")"
    title="$(node "$evidence" catalog-title "$app")"
    pnpm --filter "$app" exec playwright test e2e/automation.spec.js --config "$config" --grep "$title$" 2>&1 | tee "$validation/catalog/$app/run.log"
    node "$evidence" check-catalog "$app" "$validation/catalog/$app"
  done
}

if [[ "$stage" == probe || "$stage" == catalog || "$stage" == all ]]; then run_stage probe probe; fi
if [[ "$stage" == native || "$stage" == all ]]; then
  # A function piped to tee runs in a subshell. Keep restoration state in this shell.
  if [[ -f "$native_report" ]]; then
    cp "$native_report" "$validation/native-report-before.json"
    original_native_report=1
  fi
  restore_native_report=1
  rm -f "$native_report"
  run_stage native native
fi
if [[ "$stage" == webgpu || "$stage" == all ]]; then run_stage webgpu webgpu; fi
if [[ "$stage" == extraction || "$stage" == all ]]; then run_stage extraction extraction; fi
if [[ "$stage" == catalog || "$stage" == all ]]; then run_stage catalog catalog; fi
