# @neurodesk/synthstrip

## 0.1.1

### Patch Changes

- 257192b: Stream SynthSR and SynthStrip CPU inference by operator to avoid oversized browser allocations while preserving the pinned models. Reject normalization with less than one percent positive brain support in the MNI template before exposing downloads. Add numerical parity, allocation, failure recovery, and cropped-head regressions.
- Updated dependencies [257192b]
  - @neurodesk/runtime-support@0.1.3
