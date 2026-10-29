# SyN-SDC registration gate on the 1.2 mm grid (#462)

These scripts run the registration gate of the [SDC plan](../../../../docs/architecture/dwi-sdc-plan.md#62-gates) on the 1.2 mm SyN grid that the maintainer chose in [#462](https://github.com/neurodesk/webapps/issues/462#issuecomment-6399511502), and the precision and memory tests of that decision.
sdcflows 2.17.1 drives every run through the pinned drivers of `sdc/reference/scripts/`, so the argv, the post-registration steps and the statistic are the reference's.
`.github/workflows/sdc-registration-gate.yml` runs the SyN-only replay of the committed kernel and requires the gate.

The 29 October 2026 results, with what they do and do not establish, are in [section 6.2 of the plan](../../../../docs/architecture/dwi-sdc-plan.md#62-gates); `results-1.2mm.json` has every number with its kernel.
`results-dlmalloc.json` holds the recheck with the dlmalloc kernels of #643: the deriv64 end-to-end run with every program in WASM, deriv64 against HMC's gates and goldens, and the committed kernel's SyN call in a Chromium worker.

## Data

```sh
export $(python3 exes/dwi/sdc/validation/fetch_reference.py /var/tmp/sdc-reference registration-gate)
export $(python3 exes/dwi/sdc/validation/fetch_reference.py --folder grid /var/tmp/sdc-grid replay-1.2mm)
python3 -m venv /var/tmp/sdc-venv
/var/tmp/sdc-venv/bin/python -m pip install --no-deps -r "$SDC_REFERENCE/env/uv-pip-freeze.txt"
export SDC_PYTHON=/var/tmp/sdc-venv/bin/python
```

`registration-gate` is 22 MB of `sdc/reference/` at dataset commit `8520dbca`; `replay-1.2mm` is 152 MB of `sdc/reference/grid-q68/` at `e773666d` (the 1.2 mm double seed-1234 run and the 1.2 mm `--float 1` fields).
The reference is the native double seed-1234 run on the 1.2 mm grid: `$SDC_GRID/runs/full-1.2mm-s1234-double-affine`.

## SyN-only replay

```sh
bash packages/hmc-registration/validation/sdc-gate/replay.sh "$SDC_REFERENCE" "$SDC_GRID" /var/tmp/replay 1234 --float
"$SDC_PYTHON" -I packages/hmc-registration/validation/sdc-gate/gate.py "$SDC_REFERENCE" \
  "$SDC_GRID/runs/full-1.2mm-s1234-double-affine" /var/tmp/replay --require
```

`stage_replay.py` builds the source run that the pinned `replay_syn.py` reads: the kept `anat2epi`, `mask2epi` and `prior_msk` outputs of the 1.2 mm double run, and the EPI reference of the 2 mm double run.
The grid runs did not keep the EPI reference; it depends only on the mean b0, not on the SyN grid.
`ants-cli.mjs` runs `antsRegistration`, `antsApplyTransforms` and `ImageMath` in the kernel: it reads each file that argv names into the kernel's run directory, passes `--random-seed` from `ANTS_RANDOM_SEED` (as the reference sets the seed), and writes the outputs back.
`ANTS_REGISTRATION` and `ANTS_TOOLS` replace it by other commands, such as the native builds below.
Paths must not contain spaces.

`gate.py` reads `fmap` (node `syn_sdc_wf/unwarp`) and the field before `BSplineApprox` (`syn_sdc_wf/zooms_field`) with the pinned `compare_fields.py` and reports the median, 95th percentile and maximum of the difference over the MindGrab mask of the mean b0.
The gate is `d <= max(spread, 0.05 Hz)` and `d < 0.5 Hz`.
The spread needs native double replays at seeds 1235 and 1236 (`--spread RUN RUN`); they are not on the dataset, so the workflow checks the cap and records that the spread condition was not evaluated. Run locally, they give a spread of 0.995 Hz.

## End-to-end run

```sh
DENOISE_IMAGE=/var/tmp/hmc-native/stock/DenoiseImage \
  bash packages/hmc-registration/validation/sdc-gate/e2e.sh "$SDC_REFERENCE" /var/tmp/e2e 1234 --float
```

`e2e_driver.py` runs the pinned `sdc_driver.py` with `regrid_anat` at 1.2 mm, as `grid-q68/scripts/sdc_driver_grid.py` does, and replaces `epi_reference_wf` (the only user of FreeSurfer's `lta_convert`) by the kept EPI reference.
`epi2anat` and SyN both run in the given precision.
`affine_shift.py` reports how far an `epi2anat` affine maps the EPI brain mask from the double affine.
The kernel drops `--write-interval-volumes`, which sdcflows' debug path adds to `epi2anat`; native runs with and without it write the same affine.

Without `ANTS_REGISTRATION` and `ANTS_TOOLS`, every program the kernel has runs in it; `DenoiseImage` is the only native one. `check_calls.py` checks that from the run's call logs: it fails unless each `antsRegistration`, `antsApplyTransforms` and `ImageMath` call ran in the given kernel and exited 0, with one kernel record per call. `e2e.sh` starts from an empty work directory, so no node comes from nipype's cache, and the log lists every call.

```sh
python3 -I packages/hmc-registration/validation/sdc-gate/check_calls.py /var/tmp/e2e \
  "$(sha256sum /var/tmp/hmc-deriv64/wasm/kernel/hmc-registration.wasm | cut -d' ' -f1)"
```

## Native builds and the Mattes variants

```sh
bash packages/hmc-registration/validation/sdc-gate/native/build.sh /var/tmp/hmc-native
bash packages/hmc-registration/validation/sdc-gate/build-wasm.sh /var/tmp/hmc-deriv64 deriv64
```

`native/build.sh` builds ITK 5.4.3 through ANTs 52bc0ab's SuperBuild and four native builds of the kernel's programs with the reference's flags (`-O3 -mtune=native -march=corei7`): `stock` (3D float and double), `pdf64`, `deriv64` and `fma` (`stock` with `-march=native`, a rounding-only perturbation of the double run).
Run them with `ANTS_REGISTRATION=/var/tmp/hmc-native/stock/hmc-native` and `ANTS_TOOLS=/var/tmp/hmc-native/stock/hmc-native`; drop `--float` for double.
On the 1.2 mm double replay, `stock` writes the pinned double warp byte for byte, and its `DenoiseImage` writes the pinned `ref_anat` output.

`mattes-pdf-double.cmake` changes ITK's `MattesMutualInformationImageToImageMetricv4` through build-tree copies of its header and `.hxx`, with images, fields and transforms still float:

- `pdf64`: `PDFValueType = double`, so the joint and marginal PDFs, their sums and the metric value accumulate in double;
- `deriv64`: `pdf64`, and the derivative of a transform with global support (an affine) also accumulates in double and is rounded to float once. A displacement field has local support, so SyN is the same as with `pdf64`.

`mattes-pdf-double-check.cxx` fails the build if antsRegistration's include chain misses a copy.
`build-wasm.sh` builds the kernel with a variant in the kernel's toolchain image and leaves it in the build directory; run it with `HMC_WASM_DIR=/var/tmp/hmc-deriv64/wasm/kernel`.
On HMC's rigid test pair each variant writes the same transform in WASM and natively, and a different one from the committed kernel.
The committed kernel does not use them; section 6.2 of the plan gives their results.

## A variant against HMC's gates

HMC's NiFreeze registrations use the `GC` metric, so the Mattes variants should leave them unchanged; these commands check a build against HMC's registration replay and the package's goldens:

```sh
HMC_WASM_DIR=/var/tmp/hmc-deriv64/wasm/kernel \
  node packages/hmc-registration/validation/nifreeze-replay.mjs "$HMC_REFERENCE" /var/tmp/q53-deriv64
node packages/hmc-registration/validation/nifreeze-replay-gate.mjs "$HMC_REFERENCE" /var/tmp/q53-deriv64 /var/tmp/q53-replay
(cd exes/dwi && HMC_WASM_REPLAY=/var/tmp/q53-deriv64 cargo test --release -p dwi-hmc --test q53_replay -- --nocapture)
node packages/hmc-registration/validation/variant-goldens.mjs /var/tmp/hmc-deriv64/wasm/kernel
```

`HMC_REFERENCE` holds the `nifreeze-replay` subset of `exes/dwi/hmc/validation/reference.manifest.json`, and `/var/tmp/q53-replay` is the committed kernel's replay.
`nifreeze-replay-gate.mjs` applies HMC's accepted native-float gate (`packages/hmc/validation/nifreeze-gate.mjs`) to the 90 GP registrations, the same rule to the 11 b0 pairs as a supplement, and counts the transforms that are the committed kernel's bytes.
`q53_replay.rs` holds the historical comparison with native double to its recorded table.
`variant-goldens.mjs` runs the package's native-reference steps (`test/expected.mjs`) with the build, once wholly and once with the committed kernel's registrations, and reports which goldens keep native ANTs's bytes.

## Browser worker

`../browser-syn.mjs` runs the committed kernel's module worker (`src/worker.js`, unchanged) in Playwright's Chromium on the SyN call of a `replay.sh` run, with the same argv and files, and compares the warps with the replay's.
It records three measures separately: the worker's linear-memory capacity and each growth (it wraps `WebAssembly.Memory` in the worker's scope before the first message), the RSS and VmHWM of each Chromium process (also at the moment the reply reaches the page), and `performance.measureUserAgentSpecificMemory()`, which only the full Chromium provides.
`cancel` terminates the worker once the renderer has grown by 1 GB, follows the renderer's RSS, and runs the rigid test pair in a new worker.

```sh
HMC_BROWSER_CHANNEL=chromium node packages/hmc-registration/validation/browser-syn.mjs full /var/tmp/replay /var/tmp/browser-syn
HMC_BROWSER_CHANNEL=chromium node packages/hmc-registration/validation/browser-syn.mjs cancel /var/tmp/replay /var/tmp/browser-cancel
```

None of these measures is the allocator's live bytes or its free space, and none is the memory of a whole app.

`HMC_WASM_HEAP_TRACE=1` records the requested sizes passed to `_emscripten_resize_heap` in `wasm-calls.jsonl`. These are targets for linear-memory growth, not individual allocation sizes or the allocator's peak live footprint. The difference between a growth target and the resulting linear-memory capacity does not measure free allocation headroom. Live allocations, fragmentation and available allocator space were not measured.
