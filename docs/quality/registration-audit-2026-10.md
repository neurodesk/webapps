# Registration audit, October 2026

This audit lists every place the catalog aligns images, for issue #612. Several
apps register images as one step of a larger pipeline, often with ANTs, the
slowest engine in the catalog, and the tools and settings differ between them.
The audit records what each step runs today, what pins its output, and what a
change would have to re-record. [Outcome](#outcome-of-612) records what #612
changed; the [proposals](#proposals) are for the maintainer to decide.

Paths are relative to the repository root. Line numbers are from `main` at
`e93524d8`.

## Summary

| App | Step | Engine now | Transform | Pinned by | Verdict |
| --- | --- | --- | --- | --- | --- |
| BISON | T1 → ICBM 2009c affine (`packages/bison/src/preprocess.js` `greedyRegistration`) | Greedy NMI, image-centres start | affine | MINC agreement gates, CLI/browser byte equality | Done: Greedy (WP1) |
| BISON | T1_VP → template (`preprocess.js` `GREEDY_NONLINEAR`) | Greedy NCC r2, unmasked, from the inverse affine | SVF to 1 mm | same; prior correlation r 0.85 | Done: Greedy (WP1b) |
| BISON | FLAIR → T1 (`greedyRegistration`) | Greedy NMI, identity start | rigid | same | Done: Greedy (WP1) |
| SYNcro app | normalisation to MNI152 (`apps/syncro/src/worker.js`) | Greedy by default, ANTs SyN on request | affine + NMI SVF | ANTs path: container parity | Keep: Greedy is already the default |
| SYNcro app | pathological → primary (`worker.js`) | Greedy NMI affine | affine | none | Keep |
| SYNcro command line | normalisation (`packages/syncro/src/node.js`) | Greedy by default, ANTs SyN with `--normalization ants` | affine + NMI SVF | release check on both engines; ANTs path: container parity | Done (WP2) |
| HMC | each DWI volume → model prediction (`exes/dwi/hmc/src/registration.rs`) | ANTs, GC | two rigid stages | #451 native-float gate, reference transform hashes | Keep ANTs for NiFreeze parity (WP3 declined) |
| fastprep | T1 → MNI152NLin2009cAsym (`exes/fastprep/core/src/stages.rs`) | Greedy NMI affine + SVF with `-gm` | affine + SVF | parity with `fastprep.py` | Keep |
| fastprep | SynthSR SDC warp | Greedy NMI SVF | SVF | parity with `fastprep.py` | Keep |
| fastprep | BOLD → T1, reference alignment | niimath `-allineate` (`lpc`, `shr`) | affine, rigid | parity with `fastprep.py` | Keep |
| Deface | template + face mask → subject (`packages/deface/src/pipeline.js`) | niimath `-deface` (allineate fast or Hellinger) | affine | CLI/browser byte equality | Keep: already EdgeReg's engine |
| CALMaR | lesion T1 → MNI160 (`apps/calmar/web/js/inference-worker.js`) | PCA prealign + SynthMorph ONNX | rigid + deformable SVF | registration quality and parity fixtures | Keep: learned, no iterative engine |
| TopoFit | template surfaces → subject (`packages/topofit/src/pipeline.js`) | TReGA ONNX + least squares | affine | TReGA bit reproducibility | Keep: part of the pinned OpenRecon workflow |
| NeSVoR | slices and stacks (`packages/nesvor/src/registration`) | SVoRT ONNX + JS rigid NCC | rigid | registration comparison scripts | Keep: slice-to-volume, no general engine fits |
| DWI correct | volume → prediction (`exes/dwi/shoreline`) | own Rust rigid + eddy | rigid + eddy | FSL eddy comparisons | Keep: 30 s against 2345 s for the ANTs harness |

The sections below give each step's settings and sources.

## Available registration tools

| Tool | Kernel | Transforms | Defaults in the repo | Writes a transform | Takes an initial transform |
|---|---|---|---|---|---|
| ANTs SyN (`packages/registration`) | ANTs 2.6.2 WASM, one thread | Affine, then SyN | Fixed ANTsPy 0.6.1 `SyN` argv (`packages/registration/src/index.js:2-13`) | `0GenericAffine.mat`, `1Warp`, `1InverseWarp` | No. The argv is fixed and `register()` has no initial-transform input (`index.js:58-67`) |
| hmc-registration (`packages/hmc-registration`) | Same ANTs commit, `antsRegistration`, `antsApplyTransforms` and helpers | Any `antsRegistration` stage | None; callers pass argv. `checkArguments` only requires `--float 1` and `--random-seed` (`src/index.js:35-64`) | ITK `.mat`, warps | Yes, `--initial-moving-transform` (BISON uses it) |
| Greedy (`exes/greedy`, `packages/greedy`) | greedy-rs, Rust port of part of Greedy; threaded WASM in the browser, a committed single-threaded build (`@neurodesk/greedy/single`) in Node, CPU | Affine 12 DOF, rigid (`-dof 6`, CLI only), NMI SVF | `-n 100x50x10`, pyramid 4,2,1; the CLI affine defaults to SSD, the JS wrapper uses NMI (`exes/greedy/cli/src/main.rs:205-240`, `packages/greedy/src/index.js:14-29`) | Text 4×4 `.mat` (RAS, fixed→moving), NIfTI warp | SVF only, `-it AFFINE.mat`. The CLI affine starts from the identity unless `-ia-image-centers` is given, as Greedy; the JS wrapper starts from image centres |
| EdgeReg (`packages/edgereg`) | niimath `-allineate` (AFNI 3dAllineate fast engine), `@niivue/niimath` 1.4.20260909 WASM, one thread | Affine 12 DOF, fixed schedule | `niimath MOVING -gz 0 [-robustfov] -allineate FIXED OUT -odt input` (`packages/edgereg/src/registration.js:3,16-20`) | No. Only the resliced image | No |
| elastix (`packages/elastix`) | elastix 5.2 via `@itk-wasm/elastix` 2.1.0, one thread | Rigid, affine (default), B-spline, each a preset chain from translation | elastix `defaultParameterMap` per stage, 3 resolutions, grid 10 (`packages/elastix/src/parameter-maps.js:5-45`) | TOML parameter files, ITK HDF5 (linear only), OME-Zarr | Stages chain internally (`parameter-maps.js:67-74`). The library's `initialTransform` option is never passed (`apps/elastix/src/registration.js`, the `elastix(maps, …)` call) |
| FireANTs (`packages/fireants`) | `@fireants/fireants` 0.1.20260913, C/WASM, CPU or WebGPU | Moments → rigid → affine → greedy or SyN | Engine defaults; the repo passes no stages (`apps/fireants/src/main.js:277-295`, `packages/fireants/src/node.js:64-73`) | No. Only the warped image | The engine has `--init-affine <file>`; the repo never uses it |
| niimath `-moco`, `-allineate -savemat` | niimath WASM | Rigid motion; affine or rigid-type allineate | Per call site (fastprep, Deface; BrowserQC through `--qc --air`) | `-savemat` JSON (`fixed_to_moving`, `moving_to_fixed`) | `-applymat` replays a saved matrix; it does not seed a new registration |

EdgeReg is in the repository. It is affine only. Its first commit is by Chris
Rorden (2026-09-10); `packages/edgereg/NOTICE` credits niimath to him and
`-allineate` to AFNI 3dAllineate by Robert W. Cox.

Speeds on a 1 mm T1, as recorded in the repository:

- ANTs SyN: 49 s on an M4 Pro (`apps/ants/README.md`); SYNcro 186 s in WASM against 125 s in the container. BISON's three registrations take 1253 of the pipeline's 1352 s on sub-HML0541 (`packages/bison/docs/preprocessing.md`).
- Greedy: NMI affine 0.6 s on 14 threads, 3.8 s on one; NMI SVF 4.7 s and 22.6 s (native, `exes/greedy/README.md`).
- EdgeReg: 8–10 s, 0.3 GB (`packages/edgereg/README.md`).

Only #612's BISON measurement compares engines on the same data and host ([Outcome](#outcome-of-612)).
Greedy has no neighbourhood cross-correlation metric.

The dedicated apps (ANTs, Greedy, EdgeReg, elastix, FireANTs) register two
user images as their main purpose. Their validation:

- ANTs: `packages/ants/validation/t1-mni-reference.json`, voxel hashes and affine bytes identical (`validation/reference.mjs:19-31`). `cli-check.mjs:27` refuses a reference from another kernel.
- Greedy: no pinned reference. Browser floors on NCC (`apps/greedy/e2e/smoke.spec.js:60-79`, `e2e/automation.spec.js:43-73`). Parity with C Greedy 1.3 is an ignored test gated on `GREEDY_BENCH_DIR` (`exes/greedy/cli/tests/workflows.rs:261-310`).
- EdgeReg: `packages/edgereg/validation/t1-mni-reference.json`, header and voxel hashes identical; limits against native niimath in `validation/reference.mjs:28-35`.
- elastix: `packages/elastix/validation/t1-mni-reference.json`, parameter files byte-identical; known displacement within 1 mm (`validation/cli-check.mjs:86`).
- FireANTs: `packages/fireants/validation/t1-mni-reference.json`, voxel hash identical, NCC within 0.001 (`validation/reference.mjs:28-32`).

## Registration inside pipelines

### BISON (`packages/bison`)

Kernel: hmc-registration, a new instance every 20 runs (`src/preprocess.js:30,80-95`).
Template: ICBM 2009c nlin sym (`src/assets.js:12-13`). Shared settings: seed
1234, linear interpolation, no histogram matching, winsorize 0.005–0.995
(`src/register.js:25-35`). Every stage converges at `[iters,1e-6,10]`.

| Step | Purpose | Transform and settings | Source |
|---|---|---|---|
| T1 → template | Brain mask and priors | Greedy `-a -m NMI -ia-image-centers -n 100x50x10` (single-threaded WASM), converted to ITK `.mat` (`greedyMatrixToMat`) | `preprocess.js` `greedyRegistration`, `register.js` |
| T1_VP → template | Non-linear priors, Av_T1, Av_FLAIR | Greedy `-sv -m NCC 2x2x2 -n 100x70x50`, T1_VP fixed, `-it` the inverse of the step above, no mask; `--apply` through the warp then the inverse affine | `register.js` `GREEDY_NONLINEAR`, `preprocess.js` |
| FLAIR → T1 | FLAIR features | Greedy `-a -dof 6 -m NMI -n 100x50x10`, identity start, converted to ITK `.mat` | `preprocess.js` `greedyRegistration` |

The mapping to the upstream MINC steps is in `packages/bison/docs/preprocessing.md`.

Validation:

- `packages/bison/validation/browser-reference.json`, checked by `validation/cli-check.mjs`: labels and mask byte-identical, probability means within 1e-6.
- `test/pipeline-native.test.js:35-46` (opt-in, `BISON_FULL_PIPELINE=1`): mask Dice ≥ 0.95 and per-class Dice floors against the native reference, set at the five-subject minimum minus 0.02.
- `validation/preprocess-reference.mjs`: linear T1 mask Dice ≥ 0.97 against native.
- `test/register.test.js` checks that `--apply` through a converted Greedy matrix, and through the Greedy warp and the inverse affine, resamples as Greedy does.

The native reference (`packages/bison/validation/native`) runs upstream BISON on
MINC: `bestlinreg_s2` for the linear steps and `nlfit_s -level 2` for the
non-linear step, against BISON's `Av_T1.mnc`. Only the FLAIR → T1 rigid uses
native ANTs (`run_native.sh:172-179`), because minctracc was about 2.2 mm off.

A registration change re-records `browser-reference.json`, re-measures the
`pipeline-native` floors and updates the tables in `docs/preprocessing.md`.

### HMC (`packages/hmc`)

Each DWI volume is registered rigidly to its NiFreeze model target inside a
brain mask. Kernel: hmc-registration through a worker pool
(`packages/hmc/src/pipeline.js:128`). The argv is built in Rust
(`exes/dwi/hmc/src/registration.rs:34-97`): Rigid[12.0] GC (global
correlation), random sampling 0.4, `[20,1e-6,4]`, shrink 3, smooth 2.71 vox;
then Rigid[1.96] GC, random sampling 0.18, `[10,1e-7,2]`, shrink 2, smooth 0
(`registration.rs:45-50,81-82`). The `3` and `4` in `GC[…,1,3,Random,0.4]` and
`GC[…,1,4,Random,0.18]` fill the metric's bins/radius slot, which GC does not
use. Both stages use histogram matching, winsorize 0.063–0.991, seed 1234,
identity init.

Validation: `packages/hmc/validation/browser-reference.json` (every output
including all 137 transforms, exact), `validation/native-float-reference.json`
(WASM within the native seed spread), and the Rust argv test against 540 native
commands (`exes/dwi/hmc/tests/registration_reference.rs`). A change re-records
both JSON files.

### SYNcro (`packages/syncro`, `apps/syncro`)

| Step | Purpose | Tool and settings | Source |
|---|---|---|---|
| Pathological modality → primary | Optional second input | Greedy NMI affine `100x50x10` (both engines) | `packages/syncro/src/pipeline.js:200-204`, `apps/syncro/src/worker.js:90,123` |
| Synthetic brain → MNI152 1 mm | Normalisation, default engine in the app and the command line | Greedy NMI affine, then NMI SVF initialised with it | `worker.js:92-107`, `packages/greedy/src/index.js:20-26`, `packages/syncro/src/node.js` |
| Synthetic brain → MNI152 1 mm | Normalisation, optional engine (`--normalization ants` on the command line) | ANTs SyN, fixed ANTsPy argv | `worker.js:125-130`, `packages/syncro/src/node.js` |

Validation:

- SynthStrip + ANTs: container parity with ANTsPy 0.6.1, exact (`packages/syncro/validation/compare.py:23,26`), and full-pipeline Dice > 0.98 (`compare-complete.py`).
- SynthStrip + Greedy: the `@slow` pinned-example test selects `brainExtractor: 'synthstrip'` (`apps/syncro/e2e/automation.spec.js:67-73`). It requires brain Dice > 0.95 against the template, correlation > 0.9 and a correlation gain of 0.2 over the unregistered image (`automation.spec.js:12,128-133`).
- MindGrab + Greedy, the default: the browser test only requires the registered brain to cover at least 10 % of the template's positive voxels (`apps/syncro/e2e/quality.spec.js:49-62`).
- Every path: the runtime refuses a result covering less than 1 % of the template (`packages/syncro/src/pipeline.js:109-121`).

- SynthStrip + Greedy on the command line: against the SYNcro 0.1.1 container's ANTs result, Dice 0.990 and correlation 0.947 (`packages/syncro/validation/results/greedy-standalone.json`). The release check (`validation/package-check.mjs`) runs both engines.

The MindGrab + Greedy default in the app still has only the 10 % floor.

### fastprep (`exes/fastprep/core/src/stages.rs`)

The Rust core emits argv; the browser maps it to WASM in
`packages/fastprep/src/drivers.js:110-143`.

| Step | Tool and transform | Settings | Source |
|---|---|---|---|
| T1w → MNI, brain to brain | Greedy affine | NMI, `100x50x10`, image-centre init | `stages.rs:356-385` |
| T1w → MNI, whole head | Greedy SVF, template mask | NMI, `100x50x10`, `-it` from the affine | `stages.rs:386-404` |
| Head motion | niimath `-moco` rigid | Built-in | `stages.rs:814-833` |
| Run reference → first run (no anatomy) | niimath `-allineate -warp shr` | Fast engine | `stages.rs:580-600` |
| Fieldmap reference → boldref | niimath `-allineate -warp shr` | Fast engine | `stages.rs:927-944` |
| boldref → T1w | niimath `-allineate`, two candidates: `-cost lpc` 12 DOF and `-warp shr` | lpc kept only if within 20 mm of the rigid fit and zooms in (0.9, 1.1) | `stages.rs:1022-1071` |
| SynthSR fieldmap-less SDC | Greedy SVF, no init | NMI, `100x50x10` | `stages.rs:1188-1212` |

Validation: `packages/fastprep/test/drivers.test.js:50-72` checks the argv to
WASM mapping only. The `@slow` e2e test checks that derivatives exist. No
reference output or Dice gate pins a fastprep registration. The comment at
`stages.rs:369` records mask Dice 0.69 whole-head versus 0.96 brain-to-brain on
ds001796. A change updates the method text in `exes/fastprep/core/src/report.rs`
and affects parity with `fastprep.py`.

### CALMaR (`packages/calmar`)

| Step | Tool | Source |
|---|---|---|
| Rigid pre-alignment to lnm-mni160 from the brain mask's principal axes | Custom JS, moment based | `src/alignment.js:11-48`, `src/prealign.js:213-311` |
| Deformable registration to the template | SynthMorph ONNX (48×64×80), one forward pass; SVF integrated in JS with 7 squarings | `src/alignment.js:50-70`, `src/registration.js:114-256` |
| `mapLesion` with `structural`: native reviewed mask → atlas | Brain extraction and the same PCA pre-alignment on the T1; the mask follows the pre-alignment by nearest-neighbour resampling. After the SynthMorph pass, the deformable warp samples the mask trilinearly and thresholds it at > 0.5 (`warpReviewedMask` → `warpVolume`). A final nearest-neighbour resample puts it on the atlas grid | `src/node.js:249-300,313-329`, `src/alignment.js:72-75`, `src/registration.js:224-249` |

Validation: `packages/calmar/validation/cli-check.mjs:197-209` requires CLI vs
browser Dice ≥ 0.995 on the atlas bridge mask.
`apps/calmar/tests/fixtures/ds004884-mini/expected_registration_quality.json`
holds Dice, NCC and drift per model grid, checked by
`apps/calmar/scripts/test_registration_quality.mjs`, which `npm test` does not run.

### NeSVoR (`packages/nesvor`)

Two separate stages align the slices.

Initialisation, before reconstruction: slice-to-volume and stack registration
(`src/registration/index.js:182-247`), skipped when `registration` is `none`
(`src/workflow.js:45-49`). It uses SVoRT v2 ONNX models
(`src/registration/svort.js:23-61`) and a custom 6-DOF NCC stack registration,
3 levels, finite-difference gradient (`src/registration/stack-registration.js:13-77`).
`registerStacks` has four modes (`index.js:182-187`):

- `svort-only`: SVoRT alone. Its input poses are not the header geometry: each slice is recentred in-plane with zero rotation, keeping only its offset along the stack from the mean (`index.js:70-79`).
- `stack`: stack registration alone, starting from the header geometry (`records[].full`).
- `svort` (default): both. Stack registration keeps the first stack fixed as the reference (`stack-registration.js:86-90`). Each non-reference stack tries two starting points, the SVoRT result and the header geometry, and keeps the lower loss (`index.js:226`, `stack-registration.js:91-98`). The SVoRT slice result and the stack result are then scored and the better one is used (`index.js:219-233`).
- `svort-stack`: as `svort`, but always returns the stack result (`index.js:233`).

Alignment during reconstruction: training optimises six pose parameters per
slice together with the implicit volume, with a transformation regulariser,
whatever the initialisation mode, including `none`
(`src/training/gpu-fit.js:5-50`). With `deformable` (the fetal body preset,
`apps/nesvor/src/spec.js:52-59`) a learned per-slice deformation field is
trained as well (`src/workflow.js:56-59`).

The unit test pins one synthetic
case against upstream PyTorch (`src/registration/pipeline.test.js:62-79`).
Provenance records `validated: false` (`src/workflow.js:83`). The compute-server
job runs upstream NeSVoR's registration (`exes/compute-server/src/tools/nesvor.rs`).

### Deface (`packages/deface`)

niimath `-deface`, optionally after `-robustfov`
(`packages/deface/src/pipeline.js:8-19,67-84`), registers the subject (moving)
to avg152T1 (fixed) with an affine. It then inverts that transform to resample
the template face mask onto the subject grid (linear by default) and zeroes the
masked voxels. Both engines do this (niimath `src/allineate.c:4743-4823` at
`cf2ef5bc`, the commit the frozen build names). The comment at
`pipeline.js:71` says it "Registers the MNI template to the subject"; that
describes where the mask ends up, not the registration direction. The default
methods use allineate's fast engine. The `_hel` methods add `-cost hel`, which
selects the exhaustive Hellinger engine (`pipeline.js:70-76`). It runs the frozen
niimath build in `packages/runtime-support/src/niimath`, not the npm package EdgeReg
uses. `packages/deface/validation/browser-reference.json` pins the defaced image
bytes for `allineate` and `allineate_robustfov` only
(`validation/cases.mjs:17-21`). The Hellinger variants have no pinned reference.

### TopoFit (`packages/topofit`)

The affine that places the template surfaces is solved by weighted least
squares from point correspondences predicted by an ONNX model
(`src/pipeline.js:76-111`, `src/affine.js:10-37`). It is not an intensity
registration.

TopoFit also learns a spherical registration. Each white-surface stage updates a
per-vertex registration coordinate alongside the vertices
(`src/pipeline.js:283-305`). The exported stage predicts its displacement and
projects it onto a sphere of radius 100 (`scripts/export_models.py:323-340`).
Surface analysis maps atlas labels through it (`src/surface-analysis.js:39`).

`validation/compare.py` pins input and output hashes.

### BrowserQC (`packages/browserqc`)

niimath's `--qc --air` report registers the subject T1 affinely to the avg152T1
air template. niimath runs `-allineate` with its default options on a copy of the
RAS-reoriented T1, keeps only the affine and uses it to place the template's air
region on the subject (rordenlab/niimath `src/coreFLT.c:7067-7084` at
`2f71f3dd`). BrowserQC passes the template in the web app
(`apps/browserqc/src/main.ts:252-256`) and the command line
(`packages/browserqc/src/node.js:136-140`), both on `@niivue/niimath`
1.4.20260928.

Validation: `packages/browserqc/validation/reference.json` holds the web app's
downloads. `validation/reference.mjs:26-32` compares voxel sums and every numeric
metric of the report exactly. No check targets the affine itself; it shows only
through the air metrics. The registration lives inside niimath, so changing it
means a niimath change and re-recording `reference.json`.

### Susceptibility and eddy correction

- SDC (`exes/sdc/core/src/hysco.rs`): PyHySCO port, 1-D deformable AP/PA along the phase-encode axis. Inputs must share one space. Pinned by `apps/sdc/e2e/native-reference.json`.
- dwicorrect (`exes/dwi/shoreline`): eddy-like rigid plus eddy-current model per volume, optional slice-to-volume, and a rigid Mattes MI post-alignment of shell means (`exes/dwi/shoreline/src/peas.rs`). Checked against the native binary on a phantom (`packages/shoreline/test/agreement.test.js`).

These are method-specific models, not general registrations. They are listed
for completeness and are out of scope for a default swap.

### Apps that need registered input

These run no registration but rely on one done elsewhere:

- Disconnectome: lesion on the MNI152 1 mm grid, refused otherwise with a pointer to SYNcro (`packages/nii2tvx/src/disconnectome.js:15-21`).
- CALMaR `mapLesion` without `structural`, and the atlas-space pipelines: atlas-space mask (`packages/calmar/src/node.js:309`). With `structural`, `mapLesion` takes a native mask and registers it itself (see CALMaR above).
- ME-ICA: motion-corrected input; the moco example was made offline with `niimath -moco` (`apps/me-ica/examples.json`).
- LCModel tissue correction, easy-mp2rage: same-session images placed by header geometry only.

## Can registrations be chained?

Partly. Initial transforms are tool-specific: each tool that accepts one takes
only its own format. Applying transforms from different tools together already
exists in one place: fastprep's final niimath resample.

- Greedy affine → Greedy SVF: yes. `registerGreedy` passes the affine matrix to the SVF (`packages/greedy/src/index.js:20-26`); fastprep does the same with `-it` (`stages.rs:394`).
- ANTs affine → ANTs SyN: BISON did, through hmc-registration's `--initial-moving-transform lin.mat`, until its nonlinear step moved to Greedy (WP1b). `packages/registration` cannot take an initial transform.
- elastix: its presets chain stages internally. An external initial transform is not wired.
- FireANTs: `--init-affine` exists in the engine and is not exposed.
- Across tools: SYNcro's ANTs path reslices the image through the Greedy affine and then through the ANTs warp (`apps/syncro/src/worker.js:131-137`). That is two interpolations, not one composed transform. fastprep's final resample (`exes/fastprep/core/src/stages.rs:1375-1441`) is one niimath call that applies niimath's motion parameters (`-hmc`), the allineate BOLD → T1w JSON (`-mat`), any SDC shift map (`-vsm`) and, for the template space, the Greedy warp and affine (`-warp`, line 1380), in one interpolation (`exes/fastprep/core/src/report.rs:1137`). This is composition at resampling time; no tool takes another tool's transform as a registration start.
- EdgeReg: no. It writes only the resliced image, so nothing downstream can use its affine. niimath has `-savemat`, which fastprep uses, but EdgeReg does not call it. No converter exists between allineate JSON, Greedy `.mat`, ITK `.mat` and elastix parameter files. Greedy's matrix reader expects 16 bare numbers (`exes/greedy/core/src/reslice.rs:18-28`) and would not read the JSON.

Chaining EdgeReg's affine into a deformable registration therefore needs three things:
EdgeReg (or the shared method) to write the `-savemat` matrix, a conversion to
the target tool's format and direction convention, and an initial-transform
input on that tool. Greedy's SVF and hmc-registration already have the input;
`packages/registration`, elastix and FireANTs do not expose one.

## BISON reference caveat

BISON's native reference was built with the MINC tools (`bestlinreg_s2`,
`nlfit_s`). The `pipeline-native` Dice floors measure agreement with those
registrations (`test/pipeline-native.test.js:63-75`). A better registration can
lower that Dice. Dice against this reference is therefore insufficient on its own
to judge whether a registration change improves accuracy. A swap needs a separate
measure, such as template-to-subject overlap of manual or
independent labels, reviewed by hand, before the reference and floors are
re-recorded.

## Outcome of #612

Three apps ran ANTs implicitly: BISON, SYNcro's command line and HMC. SYNcro's command line and
BISON's three registrations changed.

### WP1: BISON's linear registrations run on Greedy

BISON's registrations stand in for MINC tools (`bestlinreg_s2`, `nlfit_s`), so the gates are the
native-MINC agreement thresholds in `packages/bison/test/pipeline-native.test.js`. The native
reference was rebuilt on its five subjects from Neurodesk's CVMFS MINC and ANTs containers; the ANTs
pipeline reproduced the documented numbers and passed all ten gates.

The T1 → template affine (`-a -m NMI -ia-image-centers`) and the FLAIR → T1 rigid
(`-a -dof 6 -m NMI`, identity start) now run on Greedy; ANTs SyN, started from the Greedy affine,
still registers T1_VP, and hmc `--apply` still resamples. With the Greedy steps every subject passed
all ten label gates, the linear mask Dice was 0.971-0.978 (gate 0.97), label agreement 0.933-0.944,
and the steps took 24-40 s each against 94 and 130 s for ANTs unloaded. The masked affine
(`-gm`, started from the unmasked one) converged but lowered the linear mask Dice to 0.92-0.97, so
it is not used. Greedy's nonlinear registration stays out: the 2 mm schedule reaches r 0.69
(unmasked) or 0.78 (masked) against ANTs CC's 0.87 and the 0.85 gate, and the longer schedules
measured in #626 failed the label gates. Greedy has only NMI; BISON's own measurements show that
cross-correlation is what brings SyN close to `nlfit_s`.

The browser worker and the command line both run Greedy's committed single-threaded WebAssembly
(`@neurodesk/greedy/single`, `src/worker.js`), so labels and mask stay byte-identical; the native
`greedy-rs` differs from the WebAssembly build in the twelfth digit of the matrix. The WebAssembly
build gained a rigid (`-dof 6`) export. [`packages/bison/docs/preprocessing.md#greedy`](../../packages/bison/docs/preprocessing.md#greedy)
has the per-subject tables.

### WP1b: BISON's nonlinear registration runs on Greedy NCC

greedy-rs gained upstream Greedy's NCC metric (`-m NCC 2x2x2`, the unweighted
`MultiComponentWeightedNCCImageMetric` and its exact gradient). On the five subjects it gave the
same correlation as Greedy 1.4 to within 0.004. With it, Greedy replaced ANTs SyN for T1_VP →
template: `-sv -m NCC 2x2x2 -n 100x70x50`, unmasked, from the inverse T1 affine. Every subject passed
all ten label gates, agreement was 0.936-0.946, and the step took 567-667 s against 1372-1615 s for
SyN on the same shared host, with a 1.46 GB WebAssembly heap against 2.2 GB. The masked 2 mm warps
correlated better (r 0.88-0.89) and took 92-198 s, but failed sub-HML0774's CSF gate: the
classification mask fell short at the brain edge. BISON now runs no `antsRegistration`; hmc
`--apply` still resamples. [`packages/bison/docs/preprocessing.md#nonlinear-step`](../../packages/bison/docs/preprocessing.md#nonlinear-step)
has the tables.

### WP2: SYNcro's command line follows the app

The command line now defaults to Greedy, as the app does, through `@neurodesk/greedy/single`; the
committed single-threaded build runs the same bytes on Linux, Windows and macOS.
`--normalization ants` keeps the ANTs SyN path and its container parity. The release check
(`validation/package-check.mjs`) normalises the pinned scan with both engines. Against the
SYNcro 0.1.1 container's ANTs result, the Greedy run's warped brain has Dice 0.990 and correlation
0.947; against the MNI152 template its Dice is 0.967 (ANTs 0.966) and correlation 0.783 (ANTs
0.815). Brain extraction stays SynthStrip, where the app defaults to MindGrab.

### WP3: HMC keeps ANTs

`docs/architecture/dwi-hmc-plan.md` keeps ANTs because NiFreeze's parity depends on its GC metric.
A Greedy option would carry no parity claim, add a control and a second argv path, and speed up a
step that takes about five minutes with four workers. It was not added.

### Not swapped

fastprep, Deface and SYNcro's app already use Greedy or allineate. CALMaR, TopoFit and NeSVoR use
learned registration that is part of the published method. DWI correct's own engine is already
two orders of magnitude faster than the ANTs harness it replaced.

## Proposals

These are for the maintainer to decide.

1. Affine initialisation. Test EdgeReg's allineate affine as the shared linear step where an app registers a subject to a template: BISON step 1, SYNcro, fastprep T1w → MNI, and the pathological-modality step in SYNcro. BrowserQC and Deface already use allineate inside niimath. This first needs `-savemat` output from `packages/edgereg` and a converter to Greedy and ITK conventions, with a round-trip test. fastprep's niimath resampler can already apply Greedy transforms alongside its own, so fastprep needs the converter only to start a registration. BISON resamples its template mask through the initial affine before the nonlinear step (`packages/bison/src/preprocess.js:193-196`, `src/register.js:117-118`), and SYNcro resamples the pathological modality through its affine in Greedy (`apps/syncro/src/worker.js:131-137`), so both also need compatible transforms for resampling.
2. Deformable step. Greedy SVF already accepts an initial affine and is the SYNcro default. Compare it against ANTs SyN (hmc-registration argv) and FireANTs on one subject-to-template case as an initial screen. One case cannot show that a default fits every pipeline: SYNcro registers an extracted synthetic brain (`packages/syncro/src/pipeline.js:215-225`), fastprep whole-head images with a template mask (`exes/fastprep/core/src/stages.rs:386-398`), and SYNcro's validation notes limit conclusions from one T1 scan (`packages/syncro/validation/README.md:37`). Evaluate the candidates on representative data for each pipeline before choosing a shared default.
3. Validation first. Every fastprep registration has no pinned reference, and SYNcro's default MindGrab + Greedy path in the app has only a 10 % overlap floor (the command line's SynthStrip + Greedy path is now compared with the container). Add a reference or overlap gate before swapping tools there, so a swap shows a measured difference.
4. Keep method-specific registrations. HMC, NeSVoR, SDC, dwicorrect, TopoFit (its affine and learned spherical registration) and CALMaR's SynthMorph are tied to their methods and parity targets. They are not candidates for a generic default.
5. BISON. Decide the acceptance measure for a new registration before changing it, per the caveat above. Every BISON registration now runs on Greedy and passes the native-agreement gates (WP1, WP1b).
