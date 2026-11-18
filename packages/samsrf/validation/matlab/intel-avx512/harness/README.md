# Research harness: the engine with the Intel reference kernels

RESEARCH ONLY. Nothing here changes the shipped port, the committed module or a release.
These scripts build the SamSrf engine with the test-only `samsrf-mkl-avx512` kernels
(MKL's AVX512_E1 branch on the recorded Intel hosts) and measure it against the recordings.
The results and their limits are in [the Intel record](../README.md).

## How the research build differs from the shipped one

`build.sh` copies `exes/samsrf`, `exes/nifti` and the `packages/samsrf` files the runner
loads into a new directory outside the checkout, applies two patches there and builds the
module with `wasm-pack --no-opt`:

- `hooks.patch` adds `samsrf_core::reference`: the MKL kernels whose rounding differs between
  the recorded hosts (`x' * y` from 51 elements, `norm` of a real double vector, double
  `y' * A`, and the factorisation and solve of a finite real double design) become
  replaceable hooks. With nothing installed, every call runs the shipped kernels.
- `install-avx512.patch` lets the WebAssembly crate depend on `samsrf-mkl-avx512` (removing
  that crate's WebAssembly guard in the copy only) and installs its kernels when the module
  starts. Single and complex kernels are not replaced.

The kernels the module runs are the crate's own code, the code that `tests/recordings.rs`
and `tests/blas_recordings.rs` gate. There is no second copy of any kernel.

## Controls

- Null control: the `hooks` build, which installs nothing, must write the committed
  module's bytes in every file of every run on both bundles (`account.py` refuses
  otherwise).
- The two hosts' bundles differ only in MAT and HDF5 headers. Every module must write the
  same bytes from both bundles; this is checked, not assumed.
- The comparison is the unmodified `compare_web_cli.py`. `account.py` reuses its readers and
  casts and counts every value. A value counts as equal only if the cast to MATLAB's class
  is exact and the bits are equal. No tolerance is applied.
- Native runs (`native.sh`) report the AMD host beside the Intel host. With the shipped
  arithmetic, the AMD host must reproduce every value.

## Reproducing

`PINS` holds the recordings that `validation/container/download.py` extracts:
`cli-reference.json` into `cli`, and `css-pipelines-reference.json` into `css-pipelines`.
`PYTHON` is an interpreter with `requirements-cli.txt` installed. Every output directory
must be new.

```sh
H=packages/samsrf/validation/matlab/intel-avx512/harness
bash $H/build.sh hooks  "$TMPDIR/build-hooks"
bash $H/build.sh avx512 "$TMPDIR/build-avx512"
PYTHON=... bash $H/run.sh packages/samsrf          "$PINS/cli" "$TMPDIR/runs-shipped"
PYTHON=... bash $H/run.sh "$TMPDIR/build-hooks/packages/samsrf"  "$PINS/cli" "$TMPDIR/runs-hooks"
PYTHON=... bash $H/run.sh "$TMPDIR/build-avx512/packages/samsrf" "$PINS/cli" "$TMPDIR/runs-avx512"
$PYTHON $H/account.py --pins "$PINS/cli" --shipped "$TMPDIR/runs-shipped" \
  --control "$TMPDIR/runs-hooks" --control-build "$TMPDIR/build-hooks/build.json" \
  --research "$TMPDIR/runs-avx512" --research-build "$TMPDIR/build-avx512/build.json" \
  --committed packages/samsrf/wasm/samsrf_wasm_bg.wasm \
  --out "$TMPDIR/account.json" --summary "$TMPDIR/matrix.json"      # equals matrix-1.json
bash $H/native.sh "$TMPDIR/build-hooks"  "$PINS/css-pipelines" "$TMPDIR/native-hooks"   # css-pipelines-hooks-1.json
bash $H/native.sh "$TMPDIR/build-avx512" "$PINS/css-pipelines" "$TMPDIR/native-avx512" # css-pipelines-avx512-1.json
```

`matrix-1.json` names the SHA-256 of both patches, of every module and of every run's
maps. The module bytes depend on the toolchain and on the build directory, because Cargo
hashes the path of `exes/nifti` into its crate metadata. The run hashes must not change: a
rebuild in another directory reproduced every one of them on both hosts.
