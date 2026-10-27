# Implicit registration audit

Issue [#612](https://github.com/neurodesk/webapps/issues/612): several apps register images as a
step inside a pipeline whose purpose is something else, often with ANTs, the slowest engine in the
catalogue. This audit lists every such step on 27 October 2026 (`f808da816`), what pins its output,
and whether to swap the engine.

The dedicated registration apps (ANTs, Greedy, elastix, FireANTs, EdgeReg) are out of scope. No
other app imports `@neurodesk/edgereg`, `@neurodesk/elastix` or `@neurodesk/fireants`.

## Engines

Measured speeds as recorded in the repository. No document compares the engines on the same data.

| Engine | Where | Transforms | Speed on a 1 mm T1 |
| --- | --- | --- | --- |
| ANTs `antsRegistration` 2.6.2, single-thread WASM | `packages/registration` (SYNcro), `packages/hmc-registration` (HMC, BISON) | rigid, affine, SyN; GC, CC, Mattes | SyN 49 s on an M4 Pro (`apps/ants/README.md`); SYNcro 186 s in WASM against 125 s in the container; BISON affine + SyN 999 s |
| Greedy (`greedy-rs`), threaded WASM | `packages/greedy`, `exes/greedy` | affine (12 DOF or `-dof 6` natively), NMI SVF; SSD, NMI; fixed mask `-gm` | NMI affine 0.6 s on 14 threads, 3.8 s on one; NMI SV 4.7 s and 22.6 s (native, `exes/greedy/README.md`) |
| niimath `-allineate` (AFNI 3dAllineate port) | `packages/edgereg`, `@niivue/niimath` | affine, rigid (`-warp shr`); fast engine, `lpc`, Hellinger | 8–10 s, 0.3 GB (`packages/edgereg/README.md`) |

Greedy has no neighbourhood cross-correlation metric. Neither Greedy nor allineate is validated
against the ANTs schedules below.

## Inventory

| App | Step | Engine now | Transform | Pinned by | Verdict |
| --- | --- | --- | --- | --- | --- |
| BISON | T1 → ICBM 2009c affine (`packages/bison/src/register.js` `affineArguments`) | ANTs, GC | rigid + affine | MINC agreement gates, CLI/browser byte equality | **Swap candidate** (WP1) |
| BISON | T1_VP → template affine + SyN (`nonlinearArguments`) | ANTs, GC + CC r2 | affine + SyN to 2 mm | same; prior correlation r 0.85 | **Swap candidate** (WP1), needs measurement |
| BISON | FLAIR → T1 (`rigidArguments`) | ANTs, Mattes | rigid | same | **Swap candidate** (WP1) |
| SYNcro app | normalisation to MNI152 (`apps/syncro/src/worker.js`) | Greedy by default, ANTs SyN on request | affine + NMI SVF | ANTs path: container parity | Keep: Greedy is already the default |
| SYNcro app | pathological → primary (`worker.js`) | Greedy NMI affine | affine | none | Keep |
| SYNcro command line | normalisation (`packages/syncro/src/node.js`, `normalization:'ants'`) | ANTs SyN only | affine + SyN | container parity, `standalone.json` Dice | **Mismatch** with the app's default (WP2) |
| HMC | each DWI volume → model prediction (`exes/dwi/hmc/src/registration.rs`) | ANTs, GC | two rigid stages | #451 native-float gate, reference transform hashes | Keep ANTs for NiFreeze parity; optional fast engine (WP3) |
| fastprep | T1 → MNI152NLin2009cAsym (`exes/fastprep/core/src/stages.rs`) | Greedy NMI affine + SVF with `-gm` | affine + SVF | parity with `fastprep.py` | Keep |
| fastprep | SynthSR SDC warp | Greedy NMI SVF | SVF | parity with `fastprep.py` | Keep |
| fastprep | BOLD → T1, reference alignment | niimath `-allineate` (`lpc`, `shr`) | affine, rigid | parity with `fastprep.py` | Keep |
| Deface | template + face mask → subject (`packages/deface/src/pipeline.js`) | niimath `-deface` (allineate fast or Hellinger) | affine | CLI/browser byte equality | Keep: already EdgeReg's engine |
| CALMaR | lesion T1 → MNI160 (`apps/calmar/web/js/inference-worker.js`) | PCA prealign + SynthMorph ONNX | rigid + deformable SVF | registration quality and parity fixtures | Keep: learned, no iterative engine |
| TopoFit | template surfaces → subject (`packages/topofit/src/pipeline.js`) | TReGA ONNX + least squares | affine | TReGA bit reproducibility | Keep: part of the pinned OpenRecon workflow |
| NeSVoR | slices and stacks (`packages/nesvor/src/registration`) | SVoRT ONNX + JS rigid NCC | rigid | registration comparison scripts | Keep: slice-to-volume, no general engine fits |
| DWI correct | volume → prediction (`exes/dwi/shoreline`) | own Rust rigid + eddy | rigid + eddy | FSL eddy comparisons | Keep: 30 s against 2345 s for the ANTs harness |

No registration was found in the other apps. SDC's `packages/sdc/src/field-fit.js` (sdcflows
SyN-SDC) and hmc-registration's SDC entry points have no app caller. SCT's
`registerByCenterOfMass` is exported but not called. BrowserQC runs niimath `--qc` with an MNI air
template; whether niimath aligns it internally is not established here.

## Swap plan

Three apps still run ANTs implicitly. Only BISON pays for it without a parity reason: on sub-HML0541
its three registrations take 1253 of the pipeline's 1352 s (`packages/bison/docs/preprocessing.md`).

### WP1: BISON on Greedy

BISON's registrations stand in for MINC tools (`bestlinreg_s2`, `nlfit_s`), not for ANTs, so no
parity claim ties them to ANTs. The gates are the native-MINC agreement in
`packages/bison/docs/preprocessing.md` and `test/pipeline-native.test.js`.

1. Add a Greedy driver beside the ANTs one in `packages/bison` (browser: `@neurodesk/greedy`;
   Node: the native `greedy-rs` through `packages/greedy/src/node.js`). The pipeline stays pure; the
   engine is an injected tool, like the denoiser.
2. Map the steps: T1 affine as `greedy -a -m NMI -ia-image-centers` (template fixed, as now);
   T1_VP as `-sv -m NMI -it <affine>`, stopping at 2 mm like `nlfit_s -level 2`; FLAIR as
   `-a -dof 6 -m NMI` from identity. The browser WASM needs a rigid (`dof 6`) export, which it
   lacks today.
3. Measure on the five native validation subjects with the existing checkpoints: linear mask Dice
   (gate 0.97), r(warped Av_T1, native) against ANTs CC's 0.85, final label agreement against
   0.933–0.944, and seconds per step.
4. Switch the default only if every gate holds. Greedy has no CC metric: if NMI SVF falls short of
   r 0.85, keep ANTs SyN and swap only the linear steps that pass their own gates (the metric matters there
   too: the T1 affine with Mattes fell to Dice 0.968, under the 0.97 gate). Record the outcome in `preprocessing.md`'s divergence section and
   rerecord `validation/browser-reference.json`.

### WP2: SYNcro command line follows the app

The app defaults to MindGrab + Greedy; the command line runs SynthStrip + ANTs only, so the two
give different results for the same input. This work package covers the registration half. `packages/syncro/validation/README.md` already requires a Greedy end-to-end
comparison before Greedy parity is claimed.

1. Run that comparison: Greedy default against the container (mask Dice, warped correlation).
2. Add `--normalization greedy|ants` to the command line with Greedy as the default, packaging
   `greedy-rs` in the node-cli release, and keep the ANTs path and its container parity as an
   option.
3. Extend `cli-check.mjs` to cover both engines.

### WP3: HMC fast engine (optional)

`docs/architecture/dwi-hmc-plan.md` keeps ANTs because NiFreeze's parity depends on its GC metric,
and lists Greedy as a later fast option with no parity claim. Keep ANTs as the default. A Greedy
rigid option needs the `dof 6` export from WP1 and a motion-estimate comparison against the ANTs
transforms on the HMC example; it would be labelled as not NiFreeze-equivalent.

### Not swapped

fastprep, Deface and SYNcro's app already use Greedy or allineate. CALMaR, TopoFit and NeSVoR use
learned registration that is part of the published method. DWI correct's own engine is already
two orders of magnitude faster than the ANTs harness it replaced.
