# TopoFit parity and reproducibility

## Problem

The production niimath browser path differed from the pinned PyTorch reference
by 0.795 to 1.564 mm mean anatomical vertex distance on `ds000001`. All four
white/pial surfaces exceeded the 0.25 mm release gate. Replacing only conforming
with the package's cubic implementation reduced the means to 0.046 to 0.068 mm.

| Surface | Niimath baseline mean (mm) | Corrected mean (mm) |
| --- | ---: | ---: |
| Left white | 0.795 | 0.046 |
| Right white | 1.418 | 0.060 |
| Left pial | 0.873 | 0.053 |
| Right pial | 1.564 | 0.068 |

The [baseline report](../../packages/topofit/validation/results/ds000001-niimath-baseline.json)
and [corrected report](../../packages/topofit/validation/results/ds000001-end-to-end.json)
retain the input, runtime, surface, and QC evidence.

OpenRecon uses nibabel 5.3.2 `processing.conform`. It creates a centered
`256 x 256 x 256` grid at 1 mm, applies SciPy order-3 spline interpolation with
constant-zero fill, and preserves the effective dtype. RAS axis permutation and
flips retain normalized rotation and shear for oblique inputs. BrainNet bypasses
conforming when the input affine's linear part is already identity.

On the real scan, niimath `-conform -ras` shifted the target translation by
`[1, 0.333333, 1.333333]` mm and rescaled/clipped intensities to `[0, 255]`.
The reference cubic int16 output spans `[-185, 1372]`. Changing the conformer
therefore changed both the geometry and the model's intensity distribution.

Runtime repeatability had a separate gap. The released browser chose one to four ONNX Runtime WebAssembly threads from the host environment, and its processing manifest included elapsed seconds.

## Usage

The worker calls one reconstruction operation. The package owns conforming,
and the executor records the settings that it uses.

`runTopofit()` receives the fixed browser session factory, tensor constructor,
verified asset loader, and executor identity. Its `conform` flag controls
whether a non-identity input grid is resampled; callers cannot supply a different
conformer.

With `conform: true`, browser and Node execution use the same cubic B-spline
implementation. Identity 1 mm grids are used unchanged. With `conform: false`,
the package validates the input grid and uses it unchanged.

## Shape

The implementation uses JavaScript records. These type sketches describe the
stable result boundary.

```ts
type Shape3 = readonly [number, number, number];
type Matrix4 = readonly [Row4, Row4, Row4, Row4];
type Row4 = readonly [number, number, number, number];
type Sha256 = string & { readonly sha256: unique symbol };

type ModelVolume = {
  dims: Shape3;
  affine: Matrix4;
  data: Float32Array | Float64Array;
};

type StableProvenance = {
  schemaVersion: 2;
  inputSha256: Sha256;
  inferenceSha256: Sha256;
  alignmentInputSha256: Sha256;
  modelInputSha256: Sha256;
  outputSha256: Record<string, Sha256>;
  runtime: ExecutorIdentity;
};

type RunResult = {
  files: readonly DownloadFile[];
  provenance: StableProvenance;
  elapsedSeconds: number;
};
```

`conformVolume()` owns RAS orientation, the integer-centered target affine,
SciPy-compatible cubic spline filtering, edge behavior, and integer output
casting. Its polar decomposition follows nibabel 5.3.2's input-axis ordering;
the target affine preserves normalized input columns instead of discarding
obliquity or shear. Before decoding voxel values, `readVolume()` estimates the peak conform buffers
and rejects inputs above the 768 MiB preprocessing budget.

## Ownership

| Location | Responsibility |
| --- | --- |
| `packages/topofit/src/volume.js` | Decode NIfTI geometry, scaling, scalar type, and source-grid QC data. |
| `packages/topofit/src/conform.js` | Own reference-compatible cubic preprocessing and its memory lifetime. |
| `packages/topofit/src/pipeline.js` | Select identity-grid bypass or cubic conforming, run the neural schedule, and assemble outputs. |
| `apps/topofit/src/onnx-runtime.js` | Create ONNX Runtime sessions and bind executor settings to executor identity. |
| `packages/topofit/src/results.js` | Write deterministic FreeSurfer surfaces. |
| `apps/topofit/src/inference-worker.js` | Fetch and share verified assets, start session and hemisphere workers, and transfer results; it never runs ONNX Runtime itself. |
| `apps/topofit/src/session-worker.js`, `hemisphere-worker.js` | Own each ONNX Runtime heap: one session for TReGA or the feature model, or one hemisphere's white and pial stages. Terminating the worker frees the heap. |
| `packages/topofit/validation` | Capture the pinned container, run the production browser, and compare immutable evidence. |

The original decoded source remains available for source-grid QC. The pipeline
records the conformer it actually used in stable provenance. Niimath remains
available in the separate printable-STL worker for mesh simplification/smoothing.

## Verification

The reference capture records the container, NumPy, SciPy, and nibabel identities, plus the effective dtype, conformed affine, and float32 model input. Compact fixture metadata belongs in Git. Large inputs and outputs belong in the immutable Hugging Face release.

Pinned fixtures cover centered interpolation, integer rounding, scaled inputs,
anisotropy, axis permutation/flips, oblique/sheared grids, and identity-grid
tolerance. A production-worker test observes the actual inference tensor hash
before model loading and requires the nibabel/SciPy reference hash. The memory
preflight budgets the worst RAS permutation before decoding.

The end-to-end gate runs the original `ds000001` input through the production browser and the pinned container. It requires exact topology, finite vertices, mean anatomical distance at most 0.25 mm, p95 at most 0.5 mm, maximum distance at most 2 mm, the existing registration limits, and at least 0.99 source-voxel QC coverage.

Repeatability runs the same production build at least twice with its fixed two-thread executor. It must produce identical surface, QC, and provenance bytes.

Each mode also pins the production output bytes (surfaces, mid-surfaces, QC) and the upstream reference geometry. A performance change passes only if every output is byte-identical to that baseline; staying within the distance thresholds is not enough. A four-thread build, for example, moved every output by about 1e-6 mm, stayed within the thresholds, and is rejected as `baseline-changed`.

The comparison rejects mixed evidence by checking the conversion status, input digest, captured conform digest, runtime identity, asset-set digest, per-output digests, and repeat output bytes.

Comparison and asset activation share the same thresholds. Activation requires
both controlled and end-to-end reports to pass, and independently checks their
metrics. It rejects missing surfaces, non-finite metrics, and weakened limits.

## Result

The fresh production capture shows that cubic conforming matches all 16,777,216
OpenRecon voxels and the target affine. Its end-to-end mean anatomical surface
distance is 0.046 to 0.068 mm, p95 is 0.098 to 0.164 mm, and maximum distance is
0.238 to 0.467 mm. These figures cover one axis-aligned OpenNeuro scan. Oblique
preprocessing has pinned numerical fixtures; a full neural parity run on an
independent oblique scan remains outside this evidence.

## Synthesis decision

Use the existing package conformer as the single production implementation and
delete the injected conformer callback. The pinned niimath package exposes
linear/nearest resampling; matching upstream cubic behavior there would require
a separate native/WASM scientific implementation. Reusing the existing cubic
code gives one preprocessing contract and passes the measured surface gate.

## Tradeoffs

- TopoFit owns its cubic preprocessing because the model requires the upstream numerical contract. Other apps' niimath paths are unchanged.
- Cubic preprocessing uses more memory than niimath; the existing 768 MiB preflight bounds supported inputs.
- The fixed two-thread executor is the fastest count measured to reproduce the single-thread bytes; more threads would be faster but change rounding. Stable provenance excludes timing, which stays available to the UI and validation sidecars.

## Alternatives

Keeping injected conformers would permit production and validation to diverge
again. Adding cubic support to shared niimath would require native/WASM changes
and validation across other applications. Shipping Python, nibabel, and SciPy
in WASM would add a much larger runtime.

## Next step

Extend full reconstruction parity beyond the single axis-aligned scan to
independent oblique scans and representative acquisition protocols. Recheck
the pinned conforming contract before updating nibabel or model assets.
