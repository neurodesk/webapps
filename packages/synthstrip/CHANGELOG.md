# @neurodesk/synthstrip

## 0.1.4

### Patch Changes

- bb10737: Add the `brain-extraction` command line: SynthStrip on ONNX Runtime Node and BET on a single-threaded WebAssembly build of the same qsm-core BET the web app runs, writing the web app's brain image and mask under the same names. It takes `--method synthstrip|bet` and BET's `--fractional-intensity`; `--method mindgrab` explains that MindGrab follows with #162. The SynthStrip model is installed with SHA-256 checks on every load, and the command line ships as portable Linux x64 and Windows x64 archives and a signed macOS arm64 installer that each bundle Node and the model. Each release must reproduce the web app's results on the pinned T1 example, as recorded in a browser: identical NIfTI headers, brain intensities and mask voxel counts, a BET mask identical bit for bit, and a SynthStrip mask Dice of 0.99995 or better. The web app now takes its download names and NIfTI writer from `@neurodesk/brain-extraction`, and its SynthStrip model pin from `@neurodesk/synthstrip/model`.
- Updated dependencies [64ffefa]
  - @neurodesk/runtime-support@0.3.0

## 0.1.3

### Patch Changes

- Updated dependencies [22aa4bf]
  - @neurodesk/runtime-support@0.2.1

## 0.1.2

### Patch Changes

- Updated dependencies
  - @neurodesk/runtime-support@0.2.0

## 0.1.1

### Patch Changes

- 257192b: Stream SynthSR and SynthStrip CPU inference by operator to avoid oversized browser allocations while preserving the pinned models. Reject normalization with less than one percent positive brain support in the MNI template before exposing downloads. Add numerical parity, allocation, failure recovery, and cropped-head regressions.
- Updated dependencies [257192b]
  - @neurodesk/runtime-support@0.1.3
