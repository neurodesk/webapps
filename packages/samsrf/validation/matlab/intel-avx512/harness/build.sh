#!/usr/bin/env bash
# RESEARCH ONLY. Builds a WebAssembly module of this checkout's SamSrf port with the
# arithmetic hooks of hooks.patch, in a new directory outside the checkout, and records
# what it built. Nothing here changes the checkout, the committed module or a release.
#
#   build.sh hooks  OUT   the hooks with nothing installed: must compute what the shipped
#                         module computes (the harness's null control)
#   build.sh avx512 OUT   the hooks with the test-only samsrf-mkl-avx512 kernels installed
#                         for real double data (install-avx512.patch)
#   build.sh avx512-real-corr OUT
#                         as avx512, but a complex corr keeps the shipped norm of y
#                         (real-corr-only.patch): an intervention on the mixed complex route
#
#   build.sh avx512-complex-corr OUT
#                         adds the fixed complex-dot candidate and complex norm candidate;
#                         complex least squares remains shipped
#
#   build.sh avx512-complex-qr OUT
#                         additionally installs the finite two-column complex QR candidate
#
# OUT must not exist. It receives exes/samsrf, exes/nifti and the packages/samsrf files that
# run_web_matrix.mjs loads, patched, with the module in OUT/packages/samsrf/wasm and
# OUT/build.json, and native/*.rs as the build's exes/samsrf/wasm/tests (native.sh runs them). The module is built without wasm-opt (the canonical build pins binaryen
# version_117; run.sh's null control checks that the unoptimized build computes the same
# outputs as the committed module). Cargo builds offline with the checkout's lock and its
# own target directory under OUT.
set -euo pipefail

usage() {
  echo "usage: $0 hooks|avx512|avx512-real-corr|avx512-complex-corr|avx512-complex-qr OUT" >&2
  exit 2
}
[[ $# -eq 2 ]] || usage
variant=$1
out=$2
case "$variant" in
  hooks | avx512 | avx512-real-corr | avx512-complex-corr | avx512-complex-qr) ;;
  *) usage ;;
esac
if [[ -e "$out" ]]; then
  echo "$out exists; give a new directory" >&2
  exit 1
fi

RUST_TOOLCHAIN=1.98.1
WASM_PACK_VERSION=0.13.1
harness="$(cd "$(dirname "$0")" && pwd)"
repo="$(git -C "$harness" rev-parse --show-toplevel)"
wasm_pack="${WASM_PACK:-$(command -v wasm-pack || true)}"
if [[ -z "$wasm_pack" || "$("$wasm_pack" --version | awk '{print $2}')" != "$WASM_PACK_VERSION" ]]; then
  echo "wasm-pack $WASM_PACK_VERSION is required" >&2
  exit 1
fi

mkdir -p "$out/exes" "$out/packages/samsrf/validation/matlab"
out="$(cd "$out" && pwd)"
rsync -a --exclude target "$repo/exes/samsrf" "$repo/exes/nifti" "$out/exes/"
rsync -a "$repo/packages/samsrf/src" "$repo/packages/samsrf/package.json" "$out/packages/samsrf/"
cp "$repo/packages/samsrf/validation/matlab/run_web_matrix.mjs" "$out/packages/samsrf/validation/matlab/"

patches=("$harness/hooks.patch")
if [[ "$variant" == avx512* ]]; then
  patches+=("$harness/install-avx512.patch")
fi
if [[ "$variant" == avx512-real-corr ]]; then
  patches+=("$harness/real-corr-only.patch")
fi
if [[ "$variant" == avx512-complex-corr || "$variant" == avx512-complex-qr ]]; then
  patches+=("$harness/complex-corr.patch")
fi
if [[ "$variant" == avx512-complex-qr ]]; then
  patches+=("$harness/complex-qr.patch")
fi
for patch in "${patches[@]}"; do
  (cd "$out" && git apply --check "$patch" && git apply "$patch")
done
mkdir -p "$out/exes/samsrf/wasm/tests"
cp "$harness"/native/*.rs "$out/exes/samsrf/wasm/tests/"

export RUSTUP_TOOLCHAIN="$RUST_TOOLCHAIN"
export CARGO_TARGET_DIR="$out/target"
cargo_home="${CARGO_HOME:-$HOME/.cargo}"
export RUSTFLAGS="--remap-path-prefix=$cargo_home=/cargo --remap-path-prefix=$out=/webapps"
"$wasm_pack" build "$out/exes/samsrf/wasm" --target web --release --no-opt \
  --out-dir "$out/packages/samsrf/wasm" -- --locked --offline
rm -f "$out/packages/samsrf/wasm/package.json" "$out/packages/samsrf/wasm/.gitignore" \
  "$out/packages/samsrf/wasm/samsrf_wasm_bg.wasm.d.ts"

# src/node.js instantiates the module (and runs its start function) as run_web_matrix.mjs
# loads it; the research export is read from that same module instance.
reference=$(cd "$out/packages/samsrf" && node --input-type=module -e "
await import('./src/node.js');
const wasm = await import('./wasm/samsrf_wasm.js');
process.stdout.write(wasm.arithmeticReference());
")
python3 -I - "$out" "$variant" "$repo" "$harness" "$reference" "${patches[@]}" <<'EOF'
import hashlib, json, subprocess, sys
from pathlib import Path
out, variant, repo, harness, reference, *patches = sys.argv[1:]
sha = lambda path: hashlib.sha256(Path(path).read_bytes()).hexdigest()
run = lambda *args: subprocess.run(args, check=True, capture_output=True, text=True).stdout.strip()
record = {
    'variant': variant,
    'arithmeticReference': reference,
    # Every copied source: the patched trees, the runner and the harness (patches, native
    # tests) must be committed for the record to name what was built.
    'checkout': {'head': run('git', '-C', repo, 'rev-parse', 'HEAD'),
                 'clean': run('git', '-C', repo, 'status', '--porcelain', '--', 'exes/samsrf', 'exes/nifti', 'packages/samsrf/src',
                              'packages/samsrf/package.json', 'packages/samsrf/validation/matlab/run_web_matrix.mjs', harness) == ''},
    'patches': {Path(p).name: sha(p) for p in patches},
    'copied': {f'native/{path.name}': sha(path) for path in sorted(Path(harness, 'native').glob('*.rs'))}
              | {'run_web_matrix.mjs': sha(Path(out, 'packages/samsrf/validation/matlab/run_web_matrix.mjs'))},
    'rustc': run('rustc', '-vV'),
    'wasmPack': run('wasm-pack', '--version'),
    'wasmOpt': 'not run',
    'module': {name: sha(Path(out, 'packages/samsrf/wasm', name))
               for name in ('samsrf_wasm.js', 'samsrf_wasm_bg.wasm', 'samsrf_wasm.d.ts')},
}
Path(out, 'build.json').write_text(json.dumps(record, indent=2) + '\n')
print(json.dumps(record, indent=2))
EOF
