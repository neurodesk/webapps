# DR-BUDDI in WebAssembly: parity, archived BBR gate and schedule sweep (#505)

This folder holds the results of issue #505 in neurodesk/webapps.
The solver is the solver-only DR-BUDDI probe of PR #596 (`exes/drbuddi-probe` at commit `9d6ca773f`): TORTOISE `1ffb8f362e8e8487d7a82cb8310d2532a9da5253`, GPL-3.0, without the bundled BET library.
The probe was not ported again. Its own `scripts/build.sh` gave the same module (`drbuddi-probe.wasm`, SHA-256 `278b6f0f036c5682f819cc43be574adbbd335ba955df5ca7ad1548804bdf8f32`).

The data are the six subjects of `../` (ds005134 sub-01, ds004146 sub-0001 to sub-0005; CC0).
The inputs are `drbuddi_inputs.py` applied to the pinned `prep/ap_mean.nii.gz` and `prep/pa_mean_reg.nii.gz` (nibabel 5.4.2); `inputs/SHA256SUMS` holds their hashes.
For sub-01 they are the same bytes as the inputs in the #596 receipt.

## Result

**No schedule passes the strict gate on all six subjects. Do not add DR-BUDDI to `apps/sdc`.**

- Native and WebAssembly fields are identical. For five schedules on sub-01, the Chromium fields are byte-identical to the native x86-64 build of the same probe (0 Hz maximum and median difference in the brain).
- The native probe on the QSIPrep "quad" grid gives voxel data bit-identical to the QSIPrep 26.1.1 `DRBUDDI` binary with the same schedule and one thread.
- The probe is not the full DR-BUDDI method. The `DRBUDDI` program first resamples the b0 pair to about 0.91 mm with a 16-voxel in-plane pad (`CreateBlipUpQuadImage`) and aligns the down b0 rigidly. The probe runs on the 2 mm grid. With the same schedule, the two fields differ by a median 2.69 Hz (maximum 29.6 Hz) in the brain on sub-01.
- Thus the port gate of the document (median < 0.1 Hz from the pinned native field of the same method, `../ds005134-sub-01/drbuddi/field_hz.nii.gz`) is not met. The probe differs from that field by a median 1.13 Hz (`default`), 1.45 Hz (`m100-300-300`) and 1.69 Hz (`c10-20-20`) in the brain.
- On the quad grid, the WebAssembly probe stops at the 4 GiB wasm32 memory limit at the start of the full-resolution stage. The heap was 4,200,595,456 bytes when it stopped (the build's maximum is 4,294,967,296 bytes). The abort does not give a reason, because the build has no assertions (`-sASSERTIONS`). Natively, the peak RSS of the same run is 3856 MiB. Thus the full method does not fit a wasm32 browser build. A memory64 build was not tried.
- On the 2 mm grid, the heap is 1,784,676,352 bytes for every schedule. The best schedules pass 3 of 6 subjects. BBR fails on sub-0001, sub-0003 and sub-0005 for every finer schedule and for the archived run. TORTOISE default fails BBR only on sub-0005, but AP-PA on sub-0001, sub-0003 and sub-0005. 10/20/20 fails BBR on five subjects.

## Gate

The strict gate of `docs/architecture/dwi-reverse-pe-options.md`, per subject, from the exact values:

- AP-PA mean absolute difference (with Jacobian) at most 1.1 x topup's;
- BBR cost (FSL 6.0.7.23 `flirt -cost bbr`, pinned `prep/t1w_wmseg.nii.gz`) no greater than topup's, from the one shared start of the #471 runs (`../<subject>/mask/b0_to_t1w_init.mat`, HF commit `8e7040a357d72def36ffdb54aa30fa8ce072d849`).

`evaluate-run.sh` scores each result with the unchanged upstream `post.sh`, `fields.py` and `evaluate.py` in a separate run root. It re-scores topup in the same way; `gate.py` stops if a re-scored topup AP-PA or BBR value is not equal to the archived value. All were equal.

AP-PA / BBR, each divided by topup's value (native probe, 2 mm grid; bold fails):

| Subject | QSIPrep default (archived) | c10-20-20 | m50-100-100 | f4-100 | m100-300-300 | f5-300 | default |
| --- | --- | --- | --- | --- | --- | --- | --- |
| ds005134-sub-01 | 0.811 / 0.9870 | 1.055 / **1.0065** | 1.022 / 0.9960 | 1.022 / 0.9962 | 1.020 / 0.9947 | 1.020 / 0.9948 | 1.019 / 0.9870 |
| ds004146-sub-0001 | 0.839 / **1.0067** | 1.085 / **1.0177** | 1.072 / **1.0076** | 1.068 / **1.0062** | 1.066 / **1.0052** | 1.066 / **1.0050** | **1.175** / 0.9987 |
| ds004146-sub-0002 | 0.810 / 0.9975 | 1.018 / **1.0077** | 0.996 / 0.9976 | 0.998 / 0.9962 | 0.995 / 0.9970 | 0.995 / 0.9969 | 1.051 / 0.9911 |
| ds004146-sub-0003 | 0.873 / **1.0093** | 1.090 / **1.0231** | 1.067 / **1.0081** | 1.067 / **1.0082** | 1.065 / **1.0054** | 1.063 / **1.0073** | **1.107** / 0.9942 |
| ds004146-sub-0004 | 0.701 / 0.9707 | 0.866 / 0.9778 | 0.849 / 0.9712 | 0.850 / 0.9713 | 0.849 / 0.9693 | 0.849 / 0.9689 | 0.914 / 0.9651 |
| ds004146-sub-0005 | 0.898 / **1.0156** | **1.171** / **1.0248** | **1.151** / **1.0123** | **1.151** / **1.0127** | **1.148** / **1.0098** | **1.148** / **1.0094** | **1.210** / **1.0060** |
| Subjects passing | 3/6 | 1/6 | 3/6 | 3/6 | 3/6 | 3/6 | 3/6 |
| Mean demeaned Δfield from topup (Hz) | 1.43 | 1.81 | 1.44 | 1.43 | 1.41 | 1.41 | 1.40 |

`gate.md` and `gate.json` hold every row, also the Chromium, quad-grid and QSIPrep runs.

## Schedules

All stages use the MSJac metric with `restrict_constrain={1:1}`; `schedules/*.json` hold the exact `--DRBUDDI_stage` strings.

| Schedule | Stages (iterations : shrink : image smoothing) | Iterations run (sub-01) | Chromium wall, sub-01 (s) | WASM heap (bytes) |
| --- | --- | --- | --- | --- |
| `c10-20-20` | 10:4:2, 20:2:1, 20:1:0 (the #596 schedule) | 50 | 61.4 | 1,784,676,352 |
| `m50-100-100` | 50:4:2, 100:2:1, 100:1:0 | 177 | 273.0 | 1,784,676,352 |
| `f4-100` | 100:8:3, 100:4:2, 100:2:1, 100:1:0 | 188 | 285.0 | 1,784,676,352 |
| `m100-300-300` | 100:4:2, 300:2:1, 300:1:0 | 229 | 400.0 | 1,784,676,352 |
| `f5-300` | 300 each at 8:4, 6:3, 4:2, 2:1, 1:0 | 244 | not run | - |
| `default` | TORTOISE's 26 default stages (no `--DRBUDDI_stage`) | 520 | 202.6 | 1,784,676,352 |

The solver stops a stage early when it converges, so the iterations run are fewer than the maximum.
The Chromium runs used headless Chromium 156.0.8078.4 (Playwright 1.64.0), one worker thread, on an otherwise idle 8-core host.
The heap is the final WASM memory size, not the process RSS.
The native runs ran 14 at a time on a 32-core host; their wall times in the receipts are not benchmarks (sub-01 `c10-20-20` took 28.6 s alone and 62-69 s in the sweep). Their peak RSS was 386-461 MB.

## Parity

`parity.json` (`parity.sh`, `compare_fields.py`), ds005134 sub-01, absolute difference in Hz in the brain mask, for the up field, the down field and the final field (`field_hz.nii.gz`):

| Comparison | Max (Hz) | Median (Hz) |
| --- | --- | --- |
| Chromium vs native probe, 2 mm grid, each of 5 schedules | 0 | 0 (byte-identical files) |
| Native probe vs QSIPrep `DRBUDDI`, quad grid, `c10-20-20`, one thread | 0 | 0 (identical voxel data) |
| Probe 2 mm grid vs QSIPrep `DRBUDDI` quad grid, `c10-20-20` | 29.6 | 2.69 |
| Probe 2 mm grid (`default`, `m100-300-300`, `c10-20-20`) vs the pinned #471 DR-BUDDI field (final field only, `probe_2mm_vs_pinned_471_drbuddi_<schedule>`) | 30.8, 35.3, 43.6 | 1.13, 1.45, 1.69 |

The native build (`native-build.sh`) uses the same container (`itkwasm/emscripten@sha256:d6c35290…`), its ITK source (ITK 5.4.6, ITK-Wasm branch commit `0fb171cc`), its clang 20 for x86-64 at `-O3`, the same TORTOISE commit, VNL patch, Boost 1.90 headers and `compat/omp.h`.
One addition: `native/missing_readImageD.cxx` defines `readImageD` as an abort. The WebAssembly link leaves that symbol as an import that aborts when called; the solver calls it only for an initial field, which the probe never gets.

## Layout

| Path | Content |
| --- | --- |
| `gate.md`, `gate.json` | the strict gate for every scored run (`gate.py`) |
| `parity.json` | the field comparisons above |
| `inputs/SHA256SUMS`, `inputs/quad-SHA256SUMS` | hashes of the 2 mm probe inputs and of the QSIPrep quad pair of sub-01 |
| `runs/native/<schedule>/<subject>/` | native probe, 2 mm grid: `receipt.json`, `probe.log.gz`, `field_hz.nii.gz`, `metrics.json`, `bbr.mat` |
| `runs/chromium/<schedule>/ds005134-sub-01/` | the same in headless Chromium, with `up.nii.gz` and `down.nii.gz` (FINV and MINV) |
| `runs/nativequad/c10-20-20/ds005134-sub-01/` | native probe on the QSIPrep quad pair |
| `runs/chromiumquad/c10-20-20/ds005134-sub-01/` | the failed Chromium run on the quad pair: `receipt.json` (`type: error`) and its log |
| `runs/qsiprep/c10-20-20/ds005134-sub-01/` | QSIPrep 26.1.1 `DRBUDDI`, one thread, `c10-20-20` |
| `scripts/` | every script of this folder, with `schedules/` and the native CMake files |

Logs have host paths replaced by `<base>` and `<home>`, and `time.log` files are left out; the receipts keep wall time and peak memory.
Quad-grid fields (264 MB each) are not included.

## Reproduce

On a Linux host with Docker, Apptainer, the FSL 6.0.7.23 Neurodesk image and the #471 run directories (`../`):

```sh
bash scripts/native-build.sh <probe source: exes/drbuddi-probe at 9d6ca773f> "$BASE/build-native"
bash scripts/sweep.sh "$BASE" 14 c10-20-20 m50-100-100 f4-100 m100-300-300 f5-300 default -- <subjects>
node scripts/browser-schedule.mjs <probe> <wasm build> <inputs/subject> scripts/schedules/<s>.json <out>
bash scripts/parity.sh "$BASE"
python3 scripts/gate.py "$BASE" gate.json > gate.md
sha256sum -c SHA256SUMS
```

`browser-schedule.mjs` is the probe's `validation/browser.mjs` with the schedule as an argument; run it from a neurodesk/webapps checkout (`docs/architecture/dwi-reverse-pe-options/drbuddi-wasm/`) after `pnpm install`.
`native/missing_readImageD.cxx` is GPL-3.0-or-later, as the probe and TORTOISE.
