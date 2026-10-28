# Registration audit, October 2026

This audit lists every place the catalog aligns images, for issue #612. Several
apps register images as one step of a larger pipeline, and the tools and
settings differ between them. The audit records what each step runs today, what
pins its output, and what a change would have to re-record. It changes no code.

Recommendations at the end are proposals. The maintainer decides.

Paths are relative to the repository root. Line numbers are from `main` at
`e93524d8`.

## Available registration tools

| Tool | Kernel | Transforms | Defaults in the repo | Writes a transform | Takes an initial transform |
|---|---|---|---|---|---|
| ANTs SyN (`packages/registration`) | ANTs 2.6.2 WASM, one thread | Affine, then SyN | Fixed ANTsPy 0.6.1 `SyN` argv (`packages/registration/src/index.js:2-13`) | `0GenericAffine.mat`, `1Warp`, `1InverseWarp` | No. The argv is fixed and `register()` has no initial-transform input (`index.js:58-67`) |
| hmc-registration (`packages/hmc-registration`) | Same ANTs commit, `antsRegistration`, `antsApplyTransforms` and helpers | Any `antsRegistration` stage | None; callers pass argv. `checkArguments` only requires `--float 1` and `--random-seed` (`src/index.js:35-64`) | ITK `.mat`, warps | Yes, `--initial-moving-transform` (BISON uses it) |
| Greedy (`exes/greedy`, `packages/greedy`) | greedy-rs, Rust port of part of Greedy; threaded WASM, CPU | Affine 12 DOF, rigid (`-dof 6`, CLI only), NMI SVF | `-n 100x50x10`, pyramid 4,2,1; the CLI affine defaults to SSD, the JS wrapper uses NMI (`exes/greedy/cli/src/main.rs:205-240`, `packages/greedy/src/index.js:14-29`) | Text 4×4 `.mat` (RAS, fixed→moving), NIfTI warp | SVF only, `-it AFFINE.mat`. The affine always starts from image centres; `-ia-image-centers` is accepted and ignored (`main.rs:221`) |
| EdgeReg (`packages/edgereg`) | niimath `-allineate` (AFNI 3dAllineate fast engine), `@niivue/niimath` 1.4.20260909 WASM, one thread | Affine 12 DOF, fixed schedule | `niimath MOVING -gz 0 [-robustfov] -allineate FIXED OUT -odt input` (`packages/edgereg/src/registration.js:3,16-20`) | No. Only the resliced image | No |
| elastix (`packages/elastix`) | elastix 5.2 via `@itk-wasm/elastix` 2.1.0, one thread | Rigid, affine (default), B-spline, each a preset chain from translation | elastix `defaultParameterMap` per stage, 3 resolutions, grid 10 (`packages/elastix/src/parameter-maps.js:5-45`) | TOML parameter files, ITK HDF5 (linear only), OME-Zarr | Stages chain internally (`parameter-maps.js:67-74`). The library's `initialTransform` option is never passed (`apps/elastix/src/registration.js`, the `elastix(maps, …)` call) |
| FireANTs (`packages/fireants`) | `@fireants/fireants` 0.1.20260913, C/WASM, CPU or WebGPU | Moments → rigid → affine → greedy or SyN | Engine defaults; the repo passes no stages (`apps/fireants/src/main.js:277-295`, `packages/fireants/src/node.js:64-73`) | No. Only the warped image | The engine has `--init-affine <file>`; the repo never uses it |
| niimath `-moco`, `-allineate -savemat` | niimath WASM | Rigid motion; affine or rigid-type allineate | Per call site (fastprep, Deface) | `-savemat` JSON (`fixed_to_moving`, `moving_to_fixed`) | `-applymat` replays a saved matrix; it does not seed a new registration |

EdgeReg is in the repository. It is affine only. Its first commit is by Chris
Rorden (2026-09-10); `packages/edgereg/NOTICE` credits niimath to him and
`-allineate` to AFNI 3dAllineate by Robert W. Cox.

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
| T1 → template | Brain mask and priors | Centre-of-mass init; Rigid[0.1] then Affine[0.1], GC; `1000x500x250x0` / `1000x500x250x50`; shrink `8x4x2x1`, smooth `3x2x1x0vox` | `register.js:66-74`, `preprocess.js:189` |
| T1_VP → template | Non-linear priors, Av_T1, Av_FLAIR | Init from the step above (`lin.mat`); Affine[0.1] GC `500x250x50`; SyN[0.1,3,0] CC radius 2, `100x70x50`, shrink `8x4x2`, smooth `3x2x1vox` | `register.js:84-92`, `preprocess.js:220` |
| FLAIR → T1 | FLAIR features | Identity init; Rigid[0.1], Mattes 32, `1000x500x250`, shrink `4x2x1`, smooth `2x1x0` | `register.js:99-105`, `preprocess.js:288` |

The mapping to the upstream MINC steps is in `packages/bison/docs/preprocessing.md`.

Validation:

- `packages/bison/validation/browser-reference.json`, checked by `validation/cli-check.mjs`: labels and mask byte-identical, probability means within 1e-6.
- `test/pipeline-native.test.js:35-46` (opt-in, `BISON_FULL_PIPELINE=1`): mask Dice ≥ 0.95 and per-class Dice floors against the native reference, set at the five-subject minimum minus 0.02.
- `validation/preprocess-reference.mjs`: linear T1 mask Dice ≥ 0.97 against native.
- `test/register.test.js:27-58` pins the argv structure.

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
(`exes/dwi/hmc/src/registration.rs:34-97`): Rigid[12.0] GC radius 3, `[20,1e-6,4]`,
shrink 3, smooth 2.71 vox; then Rigid[1.96] GC radius 4, `[10,1e-7,2]`, shrink 2,
smooth 0; histogram matching, winsorize 0.063–0.991, seed 1234, identity init.

Validation: `packages/hmc/validation/browser-reference.json` (every output
including all 137 transforms, exact), `validation/native-float-reference.json`
(WASM within the native seed spread), and the Rust argv test against 540 native
commands (`exes/dwi/hmc/tests/registration_reference.rs`). A change re-records
both JSON files.

### SYNcro (`packages/syncro`, `apps/syncro`)

| Step | Purpose | Tool and settings | Source |
|---|---|---|---|
| Pathological modality → primary | Optional second input | Greedy NMI affine `100x50x10` (both engines) | `packages/syncro/src/pipeline.js:200-204`, `apps/syncro/src/worker.js:90,123` |
| Synthetic brain → MNI152 1 mm | Normalisation, default engine | Greedy NMI affine, then NMI SVF initialised with it | `worker.js:92-107`, `packages/greedy/src/index.js:20-26` |
| Synthetic brain → MNI152 1 mm | Normalisation, optional engine; the only engine in the Node CLI | ANTs SyN, fixed ANTsPy argv | `worker.js:125-130`, `packages/syncro/src/node.js:101,107-111` |

Validation: container parity with ANTsPy 0.6.1 for the SynthStrip + ANTs path,
exact (`packages/syncro/validation/compare.py:23,26`), and full-pipeline Dice >
0.98 (`compare-complete.py`). The default MindGrab + Greedy path has only browser
floors: Dice > 0.95 on the example (`apps/syncro/e2e/automation.spec.js:130-133`)
and a 1 % template overlap guard (`pipeline.js:109-121`).
`packages/syncro/validation/README.md` says it has no end-to-end parity.

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

Validation: `packages/calmar/validation/cli-check.mjs:197-209` requires CLI vs
browser Dice ≥ 0.995 on the atlas bridge mask.
`apps/calmar/tests/fixtures/ds004884-mini/expected_registration_quality.json`
holds Dice, NCC and drift per model grid, checked by
`apps/calmar/scripts/test_registration_quality.mjs`, which `npm test` does not run.

### NeSVoR (`packages/nesvor`)

Slice-to-volume and stack registration before reconstruction
(`src/registration/index.js:182-247`). SVoRT v2 ONNX models
(`src/registration/svort.js:23-61`) and a custom 6-DOF NCC stack registration,
3 levels, finite-difference gradient (`src/registration/stack-registration.js:13-77`).
Initialisation is always the header geometry. The unit test pins one synthetic
case against upstream PyTorch (`src/registration/pipeline.test.js:62-79`).
Provenance records `validated: false` (`src/workflow.js:83`). The compute-server
job runs upstream NeSVoR's registration (`exes/compute-server/src/tools/nesvor.rs`).

### Deface (`packages/deface`)

Affine registration of avg152T1 to the subject with niimath `-deface`, the fast
allineate engine, optionally `-robustfov` and `-cost hel`
(`packages/deface/src/pipeline.js:8-19,67-84`). It runs the frozen niimath build in
`packages/runtime-support/src/niimath`, not the npm package EdgeReg uses.
`packages/deface/validation/browser-reference.json` pins the defaced image bytes.

### TopoFit (`packages/topofit`)

The affine that places the template surfaces is solved by weighted least
squares from point correspondences predicted by an ONNX model
(`src/pipeline.js:76-111`, `src/affine.js:10-37`). It is not an intensity
registration. `validation/compare.py` pins input and output hashes.

### Susceptibility and eddy correction

- SDC (`exes/sdc/core/src/hysco.rs`): PyHySCO port, 1-D deformable AP/PA along the phase-encode axis. Inputs must share one space. Pinned by `apps/sdc/e2e/native-reference.json`.
- dwicorrect (`exes/dwi/shoreline`): eddy-like rigid plus eddy-current model per volume, optional slice-to-volume, and a rigid Mattes MI post-alignment of shell means (`exes/dwi/shoreline/src/peas.rs`). Checked against the native binary on a phantom (`packages/shoreline/test/agreement.test.js`).

These are method-specific models, not general registrations. They are listed
for completeness and are out of scope for a default swap.

### Apps that need registered input

These run no registration but rely on one done elsewhere:

- Disconnectome: lesion on the MNI152 1 mm grid, refused otherwise with a pointer to SYNcro (`packages/nii2tvx/src/disconnectome.js:15-21`).
- CALMaR `mapLesion` and the atlas-space pipelines: atlas-space mask (`packages/calmar/src/node.js:309`).
- ME-ICA: motion-corrected input; the moco example was made offline with `niimath -moco` (`apps/me-ica/examples.json`).
- LCModel tissue correction, easy-mp2rage: same-session images placed by header geometry only.

## Can registrations be chained?

Partly, and only within one tool.

- Greedy affine → Greedy SVF: yes. `registerGreedy` passes the affine matrix to the SVF (`packages/greedy/src/index.js:20-26`); fastprep does the same with `-it` (`stages.rs:394`).
- ANTs affine → ANTs SyN: yes in BISON, through hmc-registration's `--initial-moving-transform lin.mat` (`packages/bison/src/register.js:87`). `packages/registration` cannot take an initial transform.
- elastix: its presets chain stages internally. An external initial transform is not wired.
- FireANTs: `--init-affine` exists in the engine and is not exposed.
- Across tools: SYNcro's ANTs path reslices the image through the Greedy affine and then through the ANTs warp (`apps/syncro/src/worker.js:131-137`). That is two interpolations, not one composed transform. fastprep's final resample composes Greedy `.mat`/warp and allineate JSON inside niimath (`stages.rs:1375-1445`).
- EdgeReg: no. It writes only the resliced image, so nothing downstream can use its affine. niimath has `-savemat`, which fastprep uses, but EdgeReg does not call it. No converter exists between allineate JSON, Greedy `.mat`, ITK `.mat` and elastix parameter files. Greedy's matrix reader expects 16 bare numbers (`exes/greedy/core/src/reslice.rs:18-28`) and would not read the JSON.

Chaining EdgeReg's affine into a deformable stage therefore needs three things:
EdgeReg (or the shared method) to write the `-savemat` matrix, a conversion to
the target tool's format and direction convention, and an initial-transform
input on that tool. Greedy's SVF and hmc-registration already have the input;
`packages/registration`, elastix and FireANTs do not expose one.

## BISON reference caveat

BISON's native reference was built with the MINC tools (`bestlinreg_s2`,
`nlfit_s`). The `pipeline-native` Dice floors measure agreement with those
registrations. A better registration can lower that Dice. Dice against this
reference is therefore not a valid check of a registration change. A swap needs
a separate measure, such as template-to-subject overlap of manual or
independent labels, reviewed by hand, before the reference and floors are
re-recorded.

## Proposals

These are for the maintainer to decide.

1. Affine initialisation. Test EdgeReg's allineate affine as the shared linear step where an app registers a subject to a template: BISON step 1, SYNcro, fastprep T1w → MNI, and the pathological-modality step in SYNcro. This first needs `-savemat` output from `packages/edgereg` and a converter to Greedy and ITK conventions, with a round-trip test.
2. Deformable step. Greedy SVF already accepts an initial affine and is the SYNcro default. Comparing it against ANTs SyN (hmc-registration argv) and FireANTs on one subject-to-template case would show whether one deformable default fits every pipeline.
3. Validation first. Greedy in SYNcro and every fastprep registration have no pinned reference. Add a reference or overlap gate before swapping tools there, so a swap shows a measured difference.
4. Keep method-specific registrations. HMC, NeSVoR, SDC, dwicorrect, TopoFit and CALMaR's SynthMorph are tied to their methods and parity targets. They are not candidates for a generic default.
5. BISON. Decide the acceptance measure for a new registration before changing it, per the caveat above.
