# dwi-dmipy

A port of dmipy 1.0.5's NODDI-Watson forward model and `brute2fine` fit for #427. The NODDI app, shared WASM package and command line offer it as `dmipy`; AMICO remains the default. The maintainer's [WM acceptance selection](https://github.com/neurodesk/webapps/issues/427) is pinned to HF commit `295e32650e9e28397909caff4b9741ee95a422c0`.

The source is [AthenaEPI/dmipy at 2d6073218eb4ebc97645ac6e275270c36834e33d](https://github.com/AthenaEPI/dmipy/tree/2d6073218eb4ebc97645ac6e275270c36834e33d), MIT. `source.manifest.json` pins the files consulted. DIPY-derived hemisphere vertices retain their BSD-3-Clause licence. See `NOTICE`, `LICENSE-DMIPY` and `LICENSE-DIPY`.

`Model::new` prepares the source's discrete Watson projection on 362 hemisphere directions, shell-specific ten-sample rotational-harmonic fits, legacy Tournier basis and 3,750-point starting grid. It clusters shells by single-linkage gaps of at most 50 s/mm² and uses b ≤ 50 as b0. Input b-values are s/mm²; DWI directions are normalized. A cluster spanning b0 and DWI is rejected explicitly.

`Model::fit` rejects a nonpositive first measurement, normalizes by the mean b0, selects the closest starting signal and applies bounded L-BFGS-B with SciPy's default absolute finite-difference step. Parameters are `[theta, phi, ODI, ICVF, ISOVF]`. The two-stage grid and bounds follow dmipy, including ISOVF grid endpoints 0 and 1 before the nonlinear bounds [0.01, 0.99]. The existing `dwi-gp` solver is reused; it ports SciPy1.18.1's C translation, whereas the reference uses SciPy1.11.4's Fortran implementation. Fit convergence is reported separately from returned parameters.

The forward model follows dmipy's sampled harmonic projections; AMICO's analytic Watson kernels are not substituted. The normalizer is dmipy's `hyp1f1(1/2, 3/2, kappa)`, evaluated by its positive power series. No NODDI toolbox `erfi` source is used.

## Source oracle

```bash
cargo test --release --manifest-path exes/dwi/Cargo.toml -p dwi-dmipy
cargo clippy --manifest-path exes/dwi/Cargo.toml -p dwi-dmipy --all-targets -- -D warnings
cargo fmt --manifest-path exes/dwi/Cargo.toml -p dwi-dmipy --check
```

The committed fixture comes from the pinned dmipy source, NumPy1.26.4, SciPy1.11.4 and DIPY1.7.0. It checks all 3,750 grid entries, chosen starts and 16 independently generated signal/fit cases, including both sides of each ODI harmonic-order boundary. Forward predictions must agree within 2e-12; fitted map parameters within 2e-5; objectives within 1e-9. These synthetic checks do not replace the slab acceptance gate.

With those packages, dmipy's import dependencies and `rustfmt` installed, regenerate the fixture and sampling source:

```bash
python exes/dwi/dmipy/tools/oracle.py PINNED_DMIPY_CHECKOUT "$TMPDIR/dmipy-oracle"
```

The generator checks every source hash before importing dmipy. Compare its `oracle.json` and `sampling.rs` with `tests/fixtures/oracle.json` and `src/sampling.rs`.

## Full slab comparison

The #426 reference is pinned to Hugging Face commit `7597121ce25529f9a819c0635da88fee6f2ac73c`, with input DWI/bval/bvec at `ce028ecca10e9abe7988f965e03ad51627ca9c52`. Provisioning verifies sizes and SHA-256 values, including cached files. Preparation requires NumPy and nibabel, verifies those pins again, then stages all 45,951 eligible brain voxels in their recorded coordinate order:

```bash
python3 exes/dwi/dmipy/validation/fetch_reference.py "$TMPDIR/dmipy-reference"
python exes/dwi/dmipy/validation/prepare_reference.py \
  "$TMPDIR/dmipy-reference" "$TMPDIR/dmipy-prepared"
cargo run --release --manifest-path exes/dwi/Cargo.toml -p dwi-dmipy \
  --example full_reference -- "$TMPDIR/dmipy-prepared" "$TMPDIR/dmipy-report.json"
```

The comparison uses one thread and reports each map's median and maximum absolute difference, counts at or above 0.02, convergence and failures. It is a correctness run; it supplies no performance benchmark. A final `wm` argument selects the 13,324 fitted WM voxels; a numeric count or comma-separated indices support small probes. WM is the published MindGrab brain mask AND FA ≥ 0.4, excluding dmipy's 8 unfitted WM voxels. Both the raw WM mask (13,332 voxels) and fitted selection are checked during preparation.

`.github/workflows/dwi-native.yml` provisions the pinned reference and runs the native data-gated test with `DMIPY_REQUIRE_REFERENCE=1`. It then runs `validation/wasm-reference.mjs` against the actual committed `packages/noddi/src/noddi.wasm`; missing data is a failure. Locally:

```bash
NODDI_DMIPY_PREPARED="$TMPDIR/dmipy-prepared" DMIPY_REQUIRE_REFERENCE=1 \
  cargo test --release --manifest-path exes/dwi/Cargo.toml -p dwi-dmipy --test reference
NODDI_DMIPY_PREPARED="$TMPDIR/dmipy-prepared" \
  node exes/dwi/dmipy/validation/wasm-reference.mjs "$TMPDIR/dmipy-wasm-report.json"
```

Both runtimes pass the accepted median absolute difference < 0.02 WM gate. Every evaluated WM voxel also stays below 0.02:

| Runtime | ICVF median / max | ISOVF median / max | ODI median / max | Nonconverged / failed |
| --- | --- | --- | --- | --- |
| Native Rust | 1.81e-8 / 0.001777 | 1.82e-8 / 0.000508 | 6.31e-9 / 0.002330 | 7 / 0 |
| Actual WASM | 2.36e-8 / 0.001775 | 1.93e-8 / 0.001627 | 7.71e-9 / 0.002245 | 4 / 0 |
| Production browser downloads | 0 / 0.001775 | 1.49e-8 / 0.001627 | 7.45e-9 / 0.002245 | 4 / 0 |

The production browser comparison uses the published float32 NIfTI reference maps; native and standalone WASM checks use the float64 fitted parameters. The browser runs the full pinned slab with the supplied WM mask, fits 13,324 voxels, skips dmipy's 8 unfitted WM voxels and downloads the maps. Its source-file provisioner verifies all 19 input/reference pins. The untagged test is `apps/noddi/e2e/dmipy-reference.spec.js`; `scripts/e2e-test-data.mjs noddi` provisions `NODDI_DMIPY_REFERENCE` for local and CI runs.

The separate native whole-brain check fits 45,951 eligible voxels, with 10 nonconverged stops and no failures. Its maximum differences are ICVF 0.02646, ISOVF 0.02761 and ODI 0.97 (3, 1 and 39 voxels at or above 0.02). Three tail probes use the same starts as pinned dmipy and agree with its objective at the Rust parameters within 7e-18, while their optimizer paths differ. These non-WM tails remain explicit; the accepted gate concerns the supplied WM set. `validation/parity-report.json` preserves the measurements and reference pins.
