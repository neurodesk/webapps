# DR-BUDDI browser feasibility probe

This is the solver-only experiment for [#505](https://github.com/neurodesk/webapps/issues/505), not an application method. It builds TORTOISE's diffeomorphic solver without its bundled BET library. Inputs are already aligned, float32, LPS-oriented mean b0 images; the wrapper does not implement the complete TORTOISE preprocessing pipeline.

The source is TORTOISE commit `1ffb8f362e8e8487d7a82cb8310d2532a9da5253` (GPL-3.0). `itk-vnl.patch` makes twelve fixed-to-dynamic VNL conversions explicit for the pinned ITK headers. `compat/omp.h` and ITK's global thread settings select one CPU thread. Both phase vectors follow the upstream solver's convention. The test pair uses voxel axis j; `validation/worker.mjs` deliberately fixes that axis and is not a general acquisition parser.

## Reproduce

Run from the repository root with Docker, Python/nibabel/numpy and the repository's Playwright Chromium installed. Generated sources, dependencies, WASM and images stay on the storage volume.

```sh
bash exes/drbuddi-probe/scripts/build.sh "$TMPDIR/drbuddi-build"
python3 docs/architecture/dwi-reverse-pe-options/fetch_results.py "$TMPDIR/drbuddi-reference" ds005134-sub-01
mkdir -p "$TMPDIR/drbuddi-inputs"
python3 docs/architecture/dwi-reverse-pe-options/drbuddi_inputs.py \
  "$TMPDIR/drbuddi-reference/ds005134-sub-01/prep/ap_mean.nii.gz" \
  "$TMPDIR/drbuddi-reference/ds005134-sub-01/prep/pa_mean_reg.nii.gz" \
  j- "$TMPDIR/drbuddi-inputs"
node exes/drbuddi-probe/validation/browser.mjs \
  "$TMPDIR/drbuddi-build" "$TMPDIR/drbuddi-inputs" "$TMPDIR/drbuddi-browser"
```

The build script pins the ITK-Wasm container by digest and verifies the Boost 1.90 archive's SHA-256 before extracting headers. It refuses source changes beyond the recorded VNL patch. The output module is about 7.6 MiB; its observed SHA-256 is `278b6f0f036c5682f819cc43be574adbbd335ba955df5ca7ad1548804bdf8f32`.

The browser harness writes both vector fields and a receipt containing the schedule, browser version, WASM checksum, elapsed solver time and WASM heap allocation. It uses three MSJac stages with 10/20/20 iterations, shrink factors 4/2/1 and image smoothing 2/1/0. A failure exits without a success receipt.

## Observed result, 2026-10-24

On the pinned ds005134 sub-01 prepared pair (116 × 116 × 68), Chromium completed the coarse schedule in 97.7 seconds on a host running other validation jobs. This is a correctness preflight, not an idle-host performance comparison. The final, monotonically grown WASM heap was 1,784,676,352 bytes (1.66 GiB); that number excludes Chromium and JavaScript allocations and is not process RSS. The rebuilt module produced byte-identical up/down fields to the initial probe.

Scoring with the repository's existing `fields.py` and `evaluate.py` gave:

| Measure | Coarse browser probe | Archived topup |
| --- | ---: | ---: |
| AP/PA mean absolute difference | 0.077216602 | 0.073205758 |
| AP/PA 1 − NCC | 0.06165694 | — |
| Demeaned field difference from topup | 2.243294537 Hz | — |
| Demeaned field difference from GRE | 3.0159934 Hz | — |

The AP/PA value passes the documented 1.1 × topup threshold (0.080526333). Acceptance also requires the strict BBR criterion. The pinned reference omits its common `mask/b0_to_t1w_init.mat` and `mask/topup_corrected_mean.nii.gz`; those inputs have been requested on the issue. A newly initialized paired comparison must be reported separately from reproducing that archived gate. Native-versus-WASM numerical parity also remains outstanding. No application option should be added on the basis of the AP/PA result alone.

A new paired BBR comparison **failed**: coarse DR-BUDDI cost 0.252793 versus topup 0.251092 (lower is better). Both registrations used one common six-degree-of-freedom initialization from the reconstructed topup mean to the MindGrab CPU brain-extracted T1, the pinned reference WM segmentation, and FSL 6.0.7.23's `bbr.sch` and `measurecost1.sch`. The FSL container was pinned at `vnmd/fsl_6.0.7.23@sha256:0748f16e5c0a0a75f27875da84076377843b8095f1ba5f41974578aac135d7de`. The original T1 SHA-256 is `fab571879a3f83803405b53a2161f60f58cb32a4a04ee5b54b7b090a61af4a6e`. This uses a new shared start, not the missing archived initialization. The coarse schedule therefore has no evidence supporting app integration; a different schedule still needs its own full acceptance check.

See [the reverse-PE evaluation](../../docs/architecture/dwi-reverse-pe-options.md) for the full gate and original data provenance. The original issue's statement that DR-BUDDI passed every subject used wider limits that the design document does not accept.
