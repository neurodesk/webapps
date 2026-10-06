# Real-data comparison with Neurodesk SYNcro

The implementation was checked against the published Neurodesk container on **OpenNeuro ds000001/sub-01/anat/sub-01_T1w.nii.gz**, the real anatomical image used by Neurodesk's own SYNcro full test. The input has 160 × 192 × 192 voxels with approximately 1 × 1.333 × 1.333 mm spacing.

These parity results describe the SynthStrip + ANTs path, which remains selectable in the browser and is still used by the standalone Node fallback. The browser now defaults to MindGrab + Greedy, so the older end-to-end parity claim must not be transferred to a default run. A paired extraction resource benchmark is recorded in [`results/brain-extraction-benchmark.json`](results/brain-extraction-benchmark.json), including a repeat with each extractor isolated in a fresh Chromium process and 100 ms Linux process-tree RSS sampling. Greedy's core and browser package have their own tests; a new real clinical end-to-end comparison remains required.

- [Neurodesk recipe and source](https://github.com/neurodesk/neurocontainers/tree/f993bfd6ea658f6d56ba5f6a131e4a8c79b7e0e7/recipes/syncro)
- [Input download](https://s3.amazonaws.com/openneuro.org/ds000001/sub-01/anat/sub-01_T1w.nii.gz)
- Input SHA-256: `bdb7022ae229c5b8edd16425928c9243c562f84082b9b8e6f97cdba8b9354a98`
- Container: `vnmd/syncro_0.1.1@sha256:51246ec424976d130bd4ed731b7e1f0d3401c22146c200664eb77fc77159e946` (tag `20251216`).
- Reference uses its real `SYNcro.py`, `py_synthsr`, `mri_synthstrip` and ANTsPy 0.6.1. Models use four CPU threads. ANTs uses one ITK thread and seed 42 for reproducibility; these controls differ from an uncontrolled default invocation.

## Results

Measured on 2026-09-08. [Machine-readable stage report](results/ds000001-sub01.json) includes source/input/output hashes, versions, geometry and timings.

| Stage, on identical stage inputs | Measured comparison |
| --- | --- |
| SynthSR, complete scan | 325 of 10,485,760 voxels differ by one uint8 intensity unit; all others match. Geometry matches exactly. |
| SynthStrip conformation/normalization | Float32 model input matches exactly. |
| SynthStrip mask and masked brain | All voxels match; mask Dice 1.0. Signed-distance maximum error 0.0000201 mm. |
| ANTs SyN | Affine parameters, forward field, inverse field and warped synthetic brain all match exactly. |
| Resampling acquired original | Every output voxel matches exactly with the same transforms. |
| Binary propagation | Smoothed-image maximum error 5.96e-8; final binary result matches exactly. |
| Categorical propagation | Nearest-neighbor label result matches exactly. |

Binary and categorical annotations are **synthetic fixtures on the real scan's grid**, not patient lesion ground truth. The reference deformation's geometric Jacobian minimum is 0.2115 with no nonpositive voxels. See [propagation report](results/propagation.json).

The complete Node pipeline allows small SynthSR/ONNX differences to propagate through brain extraction and the nonlinear optimizer. It is therefore not byte-identical end to end: brain-mask Dice is 0.9999987; warped-brain correlation is 0.99950 and warped-original correlation is 0.99975. Warped-original mean absolute intensity difference is 1.086, with a maximum of 213.44 at individual voxels. See [complete pipeline report](results/standalone.json). Correlations are computed over the union of positive-valued voxels, with the definition recorded in `compare-complete.py`.

The archived production browser report predates the native-compatible three-input interface. That historical run covered ANTs transforms, binary and categorical fixtures, MNI overlay and ZIP export; its measurements remain evidence for those unchanged low-level ANTs operations, not for the current default workflow. The current `browser-run.mjs` explicitly selects SynthStrip + ANTs, supplies one binary lesion, switches the single viewer menu to the normalized primary, and downloads the native-named outputs. Replace the archived report after the next full real-data run.

The isolated WebAssembly registration took 186.47 seconds, versus 125.49 seconds for the container reference stage including I/O; it grew to a 3,164,995,584-byte linear heap. Timings are from a shared host and are not controlled speed benchmarks or total process peak-memory measurements.

The [browser graph comparison](results/synthstrip-browser-graph.json) also checks the algebraically rewritten SynthStrip graph against the container. It preserves the mask and masked brain exactly, with signed-distance maximum error 0.0000212 mm. A fresh browser worker completes this full-volume graph; the original graph exceeds a single-tensor allocation limit.

The comparison scripts enforce exact isolated registration/propagation agreement and small inference errors. The complete-pipeline Dice >0.98 and correlation >0.99 checks are engineering regression guards, not clinically validated acceptance thresholds. One T1 scan does not establish robustness for CT, lesions, cropped scans, oblique geometry or all browser/device combinations.

## Reproduce the stage checks

Requires Docker, Node 22+, a prepared repository (`pnpm install`), and Python with nibabel, NumPy and SciPy. The container supplies its own reference dependencies. From the repository root, choose an empty work directory and cache:

```bash
syncro_work=/storage/tmp/syncro-validation
syncro_cache=/storage/tmp/syncro-model-cache
syncro_image=vnmd/syncro_0.1.1@sha256:51246ec424976d130bd4ed731b7e1f0d3401c22146c200664eb77fc77159e946
mkdir -p "$syncro_work"
curl -fL https://s3.amazonaws.com/openneuro.org/ds000001/sub-01/anat/sub-01_T1w.nii.gz -o "$syncro_work/sub-01_T1w.nii.gz"
printf '%s  %s\n' bdb7022ae229c5b8edd16425928c9243c562f84082b9b8e6f97cdba8b9354a98 "$syncro_work/sub-01_T1w.nii.gz" | sha256sum -c -
docker pull "$syncro_image"
docker run --rm --network none --user "$(id -u):$(id -g)" --entrypoint python \
  -v "$syncro_work:/work" -v "$PWD/packages/syncro/validation:/validation:ro" \
  "$syncro_image" /validation/container-reference.py /work/sub-01_T1w.nii.gz /work/reference --threads 4

pnpm --filter @neurodesk/syncro build
node packages/syncro/bin/syncro.js download-models --cache-dir "$syncro_cache"
syncro_sr="$syncro_cache/276151128c666f81eba80a6afb7f307aa3c7d58825748029ba67cf170f1460a3/synthsr.onnx"
syncro_strip="$syncro_cache/7b8eeecf3793a6c4510b9f5270ecc03d9c3262d26e08d568203a651ab4b84074/synthstrip.onnx"
node packages/synthsr/bin/synthsr.js "$syncro_work/sub-01_T1w.nii.gz" "$syncro_work/web-synthsr.nii.gz" --model "$syncro_sr" --offline --threads 4
docker run --rm --network none --user "$(id -u):$(id -g)" --entrypoint python \
  -v "$syncro_work:/work" -v "$PWD/packages/syncro/validation:/validation:ro" \
  "$syncro_image" /validation/strip-reference.py
node packages/syncro/validation/run-strip.mjs "$syncro_work/web-synthsr.nii.gz" "$syncro_strip" "$syncro_work/web-strip"
node packages/syncro/validation/run-registration.mjs \
  "$PWD/packages/registration/wasm/syncro-registration.mjs" \
  "$syncro_work/reference/template.nii.gz" "$syncro_work/reference/brain.nii.gz" \
  "$syncro_work/sub-01_T1w.nii.gz" "$syncro_work/wasm-registration"
python packages/syncro/validation/compare.py "$syncro_work" --output "$syncro_work/comparison.json"

docker run --rm --network none --user "$(id -u):$(id -g)" --entrypoint python \
  -v "$syncro_work:/work" -v "$PWD/packages/syncro/validation:/validation:ro" \
  "$syncro_image" /validation/propagation-reference.py
node packages/syncro/validation/run-propagation.mjs "$syncro_work"
python packages/syncro/validation/compare-propagation.py "$syncro_work"
node packages/syncro/bin/syncro.js "$syncro_work/sub-01_T1w.nii.gz" "$syncro_work/standalone" --offline --cache-dir "$syncro_cache" --threads 4
python packages/syncro/validation/compare-complete.py "$syncro_work/reference" "$syncro_work/standalone"
```

## Production browser and installed package

Build `apps/syncro`, serve its production bundle with cross-origin isolation, and run:

```bash
node packages/syncro/validation/browser-run.mjs \
  https://YOUR-PREVIEW/syncro/ "$syncro_work" "$syncro_cache" "$syncro_work/browser"
```

This uses the real scan, local validated models and a binary lesion fixture, explicitly selects the historically validated SynthStrip + ANTs alternatives, drives the current UI, captures screenshots, and downloads the result ZIP. Extract the ZIP into a new directory and run `compare-complete.py` against that directory. Neural networks run in separate short-lived workers to release their WebAssembly arenas between stages. The app no longer exports intermediate transform files; use the isolated registration checks when deformation-field QC is required.

Pack `packages/syncro` with `npm pack`, install the tarball into a separate npm prefix outside the repository and run its `syncro` executable on the same input/cache. This verifies that bundled imports, runtime assets and template paths do not depend on the workspace.

## Shared SynthSR GPU stage (2026-09-09)

`results/synthsr-gpu.json` records the actual SYNcro production inference worker
running the same real OpenNeuro scan on the shared hardware WebGPU browser. The
executor, Conv3D shader and graph index match upstream SynthSR commit `eeb9863`
byte-for-byte, relocated into `packages/synthsr/src`. Runtime is
`synthsr-blocked-fp32-v1`, with full-volume context, FP32, flip and sharpening.

The stage completed in 24.85 s (9.98 s inference). Compared with the pinned
container's `reference/synthsr.nii.gz`, 744 / 10,485,760 voxels differed, all by
one uint8 level; dimensions and affine were exact. This passes the existing
SynthSR thresholds (maximum error 1, mismatch fraction below 0.1%, affine error
below 0.00002 mm). This is one device/run, not a CPU/GPU speed comparison.

To reproduce, serve the original input and container SynthSR output on the app
origin, then import `browser-synthsr-stage.js` in that browser and call
`validateSynthsrStage({workerURL, inputURL, referenceURL, backend:'webgpu'})`,
using the current built `assets/inference-worker-*.js`. The function runs the
unaltered production worker and compares every output voxel. Remove temporary
validation files after the run. The existing full-pipeline report uses WASM;
this stage check does not claim downstream registration parity for GPU input.

The routine production browser tests also exercise both backends on the small
TensorFlow reference fixture when `SYNTHSR_MODEL` points to the pinned model.

A second real-scan run with NiiVue actively displaying the input also passed,
with the same 744 one-level differences and exact geometry in 25.91 s
(`results/synthsr-gpu-with-viewer.json`). The local SwiftShader integration test
initially raced viewer initialization; it passes after awaiting image readiness.
SYNcro now enables Normalize only after image/viewer initialization completes.
