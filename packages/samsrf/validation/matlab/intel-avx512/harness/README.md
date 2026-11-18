# Research harness: the engine with the Intel reference kernels

RESEARCH ONLY. Nothing here changes the shipped port, the committed module or a release.
These scripts build the SamSrf engine with the test-only `samsrf-mkl-avx512` kernels
(MKL's AVX512_E1 branch on the recorded Intel hosts) and measure it against the recordings.
The results and their limits are in [the Intel record](../README.md).

## How the research builds differ from the shipped one

`build.sh` copies `exes/samsrf`, `exes/nifti` and the `packages/samsrf` files the runner
loads into a new directory outside the checkout, applies patches there and builds the module
with `wasm-pack --no-opt`:

- `hooks.patch` adds `samsrf_core::reference`: the MKL kernels whose rounding differs between
  the recorded hosts become replaceable hooks. These are `x' * y` from 51 elements, the norm
  of a real double vector, double `y' * A`, and the factorisation and solve of a finite real
  double design. With nothing installed, every call runs the shipped kernels (variant
  `hooks`).
- `install-avx512.patch` lets the WebAssembly crate depend on `samsrf-mkl-avx512` (removing
  that crate's WebAssembly guard in the copy only) and installs its kernels when the module
  starts (variant `avx512`). Single and complex kernels are not replaced. A complex `corr`
  also takes the norm of the real `y`, which this variant replaces, so complex vertices run
  a mixed route.
- `real-corr-only.patch` (variant `avx512-real-corr`) keeps the shipped norm of `y` inside a
  complex `corr` and changes nothing else. It is an intervention that tests where the
  complex route's changes come from, not a candidate reference.

The kernels the modules run are the crate's own code, the code that `tests/recordings.rs`
and `tests/blas_recordings.rs` gate. There is no second copy of any kernel. `build.json`
records the patches, the copied native tests and runner, the toolchain and the module, and
whether every copied source was committed.

- `complex-corr.patch` (variant `avx512-complex-corr`) adds the frozen four-lane fused
  complex-dot candidate and uses the existing correctly rounded norm candidate for
  complex vectors. Complex least squares remains shipped. Its evidence and limits are
  in [the complex-dot record](../complex/README.md).

## Controls

- Null control: the `hooks` build, which installs nothing, must write the committed
  module's bytes in every file of every run on both bundles. `account.py` refuses
  otherwise.
- The two hosts' bundles differ only in MAT and HDF5 headers. Every module must write the
  same bytes from both bundles; this is checked, not assumed.
- Host roles come from the MATLAB receipts, not from folder names. `account.py` requires the
  CLI root's process to report MKL's CNR `auto` branch on an AMD CPU and ubuntu-24.04's to
  report `AVX512_E1`. `account_pipelines.py` requires the pipelines manifest to hold one
  host of each branch.
- The CLI comparison is the unmodified `compare_web_cli.py`. `account.py` reuses its readers
  and casts and counts every value. A value counts as equal only if the cast to MATLAB's
  class is exact and the bits are equal. No tolerance is applied.
- `account_pipelines.py` holds both builds' native dumps value by value against the CSS
  pipelines recording, real and imaginary parts, and lists every gained and lost value.
  With the shipped arithmetic, the AMD host must reproduce every value.

The MATLAB references are source MATLAB processes whose receipts do not attest the input
bundle. None of this is compiled-image (container) or browser UI evidence.

## Reports

Each folder is named after the committed module the CLI matrix compares with, followed by a
sequence number. Reports are kept as written, so a later run never relabels an earlier one.

- `4c1a23a8-1/`: the first run (at `8c5009fc1`), kept unchanged. Its CSS-pipeline files count
  each build's matches with MATLAB but no transitions, which hid six losses. Its
  `divergence/` reports were reproduced byte for byte at `a31a71baf`.
- `4c1a23a8-2/`: the run after the review (builds at `9d4a73d33` and `a31a71baf`). It holds
  `matrix.json` and `matrix-real-corr.json` (`account.py --summary`), and `pipelines.json`
  and `pipelines-real-corr.json` (`account_pipelines.py`).
- `cc528cf6-1/`: the rerun on the combined module (#876 merged with main, at `827dbcaad`):
  `matrix.json` and `matrix-real-corr.json`. Its CSS-pipeline dumps, and so its pipeline
  reports, were byte-identical to `4c1a23a8-2/`'s, and its departure reports to
  `4c1a23a8-1/`'s; they are not duplicated.

- `cc528cf6-2/`: the complex-dot/norm candidate frozen at `040fbe29e`, on the same
  committed baseline. `matrix.json` and `pipelines.json` retain both-host per-value
  accounting. `relative-to-prior-research.json` separately counts transitions from
  the original `avx512` research build, rather than relabelling it as shipped.

## Reproducing

`PINS` holds the recordings that `validation/container/download.py` extracts:
`cli-reference.json` into `cli`, and `css-pipelines-reference.json` into `css-pipelines`.
`PYTHON` is an interpreter with `requirements-cli.txt` installed. Every output directory
must be new.

```sh
H=packages/samsrf/validation/matlab/intel-avx512/harness
for v in hooks avx512 avx512-real-corr; do bash $H/build.sh $v "$TMPDIR/build-$v"; done
PYTHON=... bash $H/run.sh packages/samsrf "$PINS/cli" "$TMPDIR/runs-shipped"
for v in hooks avx512 avx512-real-corr; do
  PYTHON=... bash $H/run.sh "$TMPDIR/build-$v/packages/samsrf" "$PINS/cli" "$TMPDIR/runs-$v"
  bash $H/native.sh "$TMPDIR/build-$v" "$PINS/css-pipelines" "$TMPDIR/native-$v"
done
for v in avx512 avx512-real-corr; do
  $PYTHON $H/account.py --pins "$PINS/cli" --shipped "$TMPDIR/runs-shipped" \
    --control "$TMPDIR/runs-hooks" --control-build "$TMPDIR/build-hooks/build.json" \
    --research "$TMPDIR/runs-$v" --research-build "$TMPDIR/build-$v/build.json" \
    --committed packages/samsrf/wasm/samsrf_wasm_bg.wasm \
    --out "$TMPDIR/account-$v.json" --summary "$TMPDIR/matrix-$v.json"
  $PYTHON $H/account_pipelines.py --pins "$PINS/css-pipelines" \
    --baseline "$TMPDIR/native-hooks/css-pipelines.tsv" --baseline-build "$TMPDIR/build-hooks/build.json" \
    --research "$TMPDIR/native-$v/css-pipelines.tsv" --research-build "$TMPDIR/build-$v/build.json" \
    --out "$TMPDIR/pipelines-$v.json"
done
```

The summaries name the SHA-256 of every patch, every module and every run's maps. Module
bytes depend on the toolchain and on the build directory, because Cargo hashes the path of
`exes/nifti` into its crate metadata. The run hashes must not change: a rebuild in another
directory reproduced every one of them on both hosts.

The next isolated variant, `avx512-complex-qr`, adds the finite two-column complex-double
least-squares candidate described in [the QR study](../complex-qr/README.md). It layers
`complex-qr.patch` after the unchanged complex-correlation patch. Its downstream results
are recorded separately; the previous reports retain their original baseline.
