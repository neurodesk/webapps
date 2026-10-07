# @neurodesk/synthsr

## 0.6.20261007

### Patch Changes

- Updated dependencies [22aa4bf]
  - @neurodesk/runtime-support@0.2.1
- Updated dependencies
  - @neurodesk/runtime-support@0.2.0

## 0.6.20261005

### Patch Changes

- Share native result publication between SynthSR and SynthSeg. Clean up newly created temporary files after failed writes while preserving each caller’s publication order and overwrite policy. Keep native path bytes when naming sibling temporaries.

## 0.6.20261004

### Minor Changes

- 257192b: Stream SynthSR and SynthStrip CPU inference by operator to avoid oversized browser allocations while preserving the pinned models. Reject normalization with less than one percent positive brain support in the MNI template before exposing downloads. Add numerical parity, allocation, failure recovery, and cropped-head regressions.

### Patch Changes

- Share native affine inversion and RAS axis selection between SynthSR and SynthSeg,
  including SynthSeg WASM, while preserving each method's preprocessing and outputs.
- Share raw NIfTI-1 header and scalar decoding between native SynthSR, native
  SynthSeg and SynthSeg WASM while preserving each reader's validation, precision,
  scaling and geometry rules.
- Updated dependencies [257192b]
  - @neurodesk/runtime-support@0.1.3

## 0.5.20261004

## 0.5.20261003

## 0.5.20260930

## 0.5.20260928

## 0.4.20260928

## 0.4.20260924

## 0.4.20260923

## 0.4.20260920

## 0.4.20260918

## 0.4.20260916

## 0.4.20260915

## 0.3.20260914

### Patch Changes

- Updated dependencies [3cd773f]
  - @neurodesk/runtime-support@0.1.2

## 0.3.20260910

### Patch Changes

- Updated dependencies [3fe15c3]
  - @neurodesk/runtime-support@0.1.1
