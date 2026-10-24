# Deterministic SyN-SDC field fitting

`dwi-sdc` ports the deterministic field conversion and high-frequency B-spline fit from sdcflows 2.17.1, commit `96a4e1425923d180569dcccd6ca688e9fa54874d`. This Apache-2.0/BSD-3-Clause crate is separate from the GPL PyHySCO implementation in `exes/sdc`. It has no NIfTI parser or runtime dependencies.

The API takes validated grid geometry and Float32 voxel arrays. Public arrays are x-fastest. Displacements are interleaved LPS millimetres. `displacement_to_field` uses the EPI affine to convert LPS vectors to PE voxel shifts, rounds those shifts to Float32, then divides by the signed readout time. Its displacement samples may lie on a different grid. Conversions refuse readout times that do not fit a finite positive Float32 and refuse results outside the finite Float32 range. `field_to_displacement` reverses that conversion on the supplied field grid.

`approximate` implements one `(16, 16, 10)` mm cubic tensor-product grid, no mask, no recentering and full-grid extrapolation. It uses Ridge alpha `1e-4`, no intercept, and Float32 conjugate gradient with relative tolerance `1e-4`, absolute tolerance zero and the source's default iteration limit. The working grid must have spacing of at least 1 mm. sdcflows' submillimetre pre-resampling must happen before this entry point. The accepted 2 mm SyN pipeline and its pinned EPI fitting grid need no such resampling.

The collocation matrix preserves NumPy's C-order traversal internally so transpose accumulation matches SciPy. Coefficients and evaluated fields return in x-fastest order. `evaluate` reconstructs a field from coefficients independently of fitting. Corresponding grid axes must be parallel, including sign flips. The source separable operator warns on rotated bases; this entry point refuses them. Project or resample to an aligned grid before evaluation.

## Numerical reproducibility

The reference host is an AMD Ryzen 9 9950X. OpenBLAS selects its SkylakeX kernel. Float32 CG's stopping iteration changes when a dot reduction changes: a scalar reduction and the Haswell reduction do not satisfy the reference's fixed `1e-4` Hz gates. The crate expresses the reference SkylakeX dot reduction in portable Rust, including fused accumulation and the Float64 scalar tail, so native and WebAssembly use identical arithmetic. It does not select a kernel from the current machine's CPU.

The reduction follows OpenBLAS `sdot.c` and `sdot_microk_skylakex-2.c` at commit `af560c1935c357e314f1f03cbbedf53f88345d38`. Attribution and licences are in `LICENSE-SDCFLOW` and `LICENSE-OPENBLAS`.

## Checks

```sh
cargo +1.98.0 test --manifest-path exes/dwi/Cargo.toml -p dwi-sdc -p sdc-wasm
cargo +1.98.0 clippy --manifest-path exes/dwi/Cargo.toml -p dwi-sdc -p sdc-wasm --all-targets -- -D warnings
cargo +1.98.0 fmt --manifest-path exes/dwi/Cargo.toml --all --check
```

The small synthetic fixtures run the original sdcflows `BSplineApprox` with NumPy 2.5.4, SciPy 1.18.1 and scikit-learn 1.9.1. Their 27 control points use the architecture-independent scalar dot tail. The full-brain reference separately exercises the vector reduction. Regenerate the fixtures from the repository root with:

```sh
uv run --python 3.13 --with sdcflows==2.17.1 --with scikit-learn==1.9.1 \
  --with numpy==2.5.4 --with scipy==1.18.1 \
  python exes/dwi/sdc/validation/make_synthetic.py
```

The pinned full-brain reference is fetched and checked as follows:

```sh
export $(python3 exes/dwi/sdc/validation/fetch_reference.py "$TMPDIR/sdc-reference" field-fit)
node exes/dwi/sdc/validation/prepare-reference.mjs "$SDC_REFERENCE" "$TMPDIR/sdc-field-fit"
SDC_REQUIRE_REFERENCE=1 SDC_FIELD_FIT_REFERENCE="$TMPDIR/sdc-field-fit" \
  cargo +1.98.0 test --release --locked --manifest-path exes/dwi/Cargo.toml \
  -p dwi-sdc --test reference -- --nocapture
```

Run `node exes/dwi/sdc/validation/wasm-reference.mjs` with the same `SDC_FIELD_FIT_REFERENCE` to check the committed WebAssembly against those native outputs. CI runs both kernels.

The reference test keeps the accepted `1e-4` Hz median gates for displacement conversion, coefficients and the fitted in-brain field, and reports maxima. The pinned ds005134 run matches bit for bit: all reported median and maximum errors are zero. `SDC_REQUIRE_REFERENCE` makes missing data a failure in CI.

The WebAssembly entry points reject fitting or evaluation whose conservative CSR and working-buffer footprint exceeds 3.5 GiB of the 4 GiB address space. The estimate covers 64 possible weights per voxel, row maps, scalar buffers, coefficient/CG vectors and axis stencils; 512 MiB remains for the allocator, stack and host ABI. CSR storage is reserved fallibly once, without capacity doubling. Native Rust retains the host address space and uses fallible CSR reservations. The oversized-grid test checks geometry alone and allocates no large voxel arrays.

The browser/Node C ABI is `sdc-wasm`; the separately licensed package entry point is `@neurodesk/sdc/field-fit`. Rebuild its committed module with `packages/sdc/scripts/build-field-fit.sh`, or add `--check` to compare a rebuild byte for byte. The script pins Rust 1.98.0 and Binaryen 117 and remaps source paths.
