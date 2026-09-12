# TopoFit parity and reproducibility

## Problem

The released browser differed from OpenRecon by 0.467 to 0.562 mm mean anatomical surface distance when both processed the original anisotropic `ds000001` scan. The distance fell to 0.052 to 0.062 mm when both received the same conformed volume. These results placed the largest error at the conforming boundary.

OpenRecon uses nibabel 5.3.2 `processing.conform`. It creates a centered `256 x 256 x 256` RAS grid at 1 mm, applies SciPy order-3 spline interpolation with constant-zero fill, and preserves the reference dtype boundary. The released browser used Niimath RAS reorientation and Lanczos resizing, which created a different field of view, center, and scalar representation.

Runtime repeatability had a separate gap. The released browser chose one to four ONNX Runtime WebAssembly threads from the host environment, and its processing manifest included elapsed seconds.

## Usage

The worker calls one reconstruction operation. The package owns the scientific preprocessing contract and the executor records the settings that it uses.

`runTopofit()` owns conforming and receives the fixed browser session factory,
tensor constructor, verified asset loader, and executor identity. The worker no
longer injects an app-local resampler.

With `conform: true`, the package always runs the pinned OpenRecon 0.5.1 conform operation. With `conform: false`, the package validates the input grid and uses it unchanged. The app cannot substitute another resampler under the same model name.

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
  data: Float32Array;
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

`conformVolume()` owns RAS orientation for axis-aligned inputs, nibabel's integer-centered target affine, SciPy-compatible cubic spline filtering, mirror-edge interpolation, constant-zero fill, and integer output casting. It uses separable Float64 interpolation stages and returns the final Float32 model volume. On the release fixture, peak Node resident memory is approximately 457 MB and conforming takes approximately 6.7 seconds.

## Ownership

| Location | Responsibility |
| --- | --- |
| `packages/topofit/src/volume.js` | Decode NIfTI geometry, scaling, scalar type, and source-grid QC data. |
| `packages/topofit/src/conform.js` | Own the pinned OpenRecon conform operation and its memory lifetime. |
| `packages/topofit/src/pipeline.js` | Prepare the image, run the existing neural schedule, and assemble outputs. |
| `packages/topofit/src/browser.js` | Create ONNX Runtime sessions and bind executor settings to executor identity. |
| `packages/topofit/src/results.js` | Write deterministic FreeSurfer surfaces. |
| `apps/topofit/src/inference-worker.js` | Fetch verified assets, create one executor per worker, and transfer results. |
| `packages/topofit/validation` | Capture the pinned container, run the production browser, and compare immutable evidence. |

The app-local conformer is deleted. Source-grid QC behavior and all output names remain unchanged.

## Verification

The reference capture records the container, NumPy, SciPy, and nibabel identities, plus the effective dtype, conformed affine, and float32 model input. Compact fixture metadata belongs in Git. Large inputs and outputs belong in the immutable Hugging Face release.

Unit fixtures cover centered cubic interpolation, integer rounding, anisotropy, axis permutation, and axis flips against SciPy and nibabel outputs. The production validation additionally requires the exact conformed-tensor SHA-256 captured from the immutable container. Oblique inputs remain rejected with an actionable error.

The end-to-end gate runs the original `ds000001` input through the production browser and the pinned container. It requires exact topology, finite vertices, mean anatomical distance at most 0.25 mm, p95 at most 0.5 mm, maximum distance at most 2 mm, the existing registration limits, and at least 0.99 source-voxel QC coverage. The previous 0.467 to 0.562 mm result is the failing baseline.

Repeatability runs the same production build at least twice with one thread. A fixed executor must produce identical surface, QC, and provenance bytes.

The comparison rejects mixed evidence by checking the conversion status, input digest, captured conform digest, runtime identity, asset-set digest, per-output digests, and repeat output bytes.

## Result

The captured browser conform tensor matches all 16,777,216 OpenRecon voxels and the target affine exactly. End-to-end mean anatomical surface distance is now 0.046 to 0.068 mm, p95 is 0.098 to 0.164 mm, and maximum distance is 0.238 to 0.467 mm. Two independent production-browser runs produced byte-identical surfaces, QC NIfTI, and stable manifest. Their elapsed times, recorded separately, were 173 and 170 seconds.

## Synthesis decision

Three candidates explored the design. Candidate 1 supplied the base: always run the reference branch when conforming is enabled, bind executor identity to execution, and require exact repeatability. Candidate 3's release-evidence consistency check is also included.

The design rejects unproved conform shortcuts, tolerance within one fixed executor, and public resampling plans. It postpones affine-solver and ONNX graph changes until exact conforming measures the remaining error.

## Tradeoffs

- We accept a TopoFit-specific cubic implementation in exchange for a testable match to the pinned reference.
- We start with plain JavaScript so Node and the browser run the same numerical code. If measured latency or memory exceeds the release budget, move the private kernel to WASM without changing its contract.
- We use one thread for a fixed production policy. This costs runtime but removes a host-dependent executor choice.
- We change the provenance schema so scientific metadata is byte-stable. Timing stays available to the UI and validation sidecars.

## Alternatives

Extending Niimath with more flags does not encode nibabel's center, prefilter, edge, and dtype rules. A generic resampling API would expose those rules to callers. Shipping Python, nibabel, and SciPy in WASM would add a large runtime and opaque memory behavior. None of these options is a better first implementation.

## Next step

The remaining 0.05 to 0.07 mm error is at the ONNX/runtime and affine-solve boundary. Any further tightening starts with isolated activation and affine-solver evidence; it does not change preprocessing again without a failing conform fixture.
