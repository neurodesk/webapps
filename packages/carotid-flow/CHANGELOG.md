# @neurodesk/carotid-flow

## 0.4.20261010

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.12.1
## 0.4.20261009

### Patch Changes

- Updated dependencies [66bf9e9]
- Updated dependencies [501ea0c]
  - @neurodesk/webapp-components@0.12.0

## 0.4.20261007

### Minor Changes

- 56a9269: Add the `carotid-flow` command line. It detects both carotids in a NIfTI phase-contrast series, as one combined series or an amplitude and a phase file, and writes the web app's label map, temporal SD and curves CSV byte for byte. Settings are checked against the app's automation schema, raw ±4096 phase without `--venc` is refused, and portable Linux x64, Windows x64 and macOS arm64 archives bundle a private Node runtime. Each archive must match the PCMCalculator example pins before release. The detection code moves from the app into `@neurodesk/carotid-flow`, which the app now imports.

### Patch Changes

- Updated dependencies [22aa4bf]
  - @neurodesk/webapp-components@0.11.1
- Updated dependencies
  - @neurodesk/webapp-components@0.11.0
- 56a9269: Decode unrescaled raw Siemens phase (0–4095, zero velocity at 2048) with the VENC and measure it with the velocity method; it previously went to the variability method with the VENC ignored. Without a VENC such a series still takes the variability method, as before, with a note that it looks like raw phase. A VENC beside an unsigned series that cannot be told apart from a speed image is refused. An amplitude and phase pair whose affine or voxel spacing differ is now refused instead of being combined voxel for voxel.
- Updated dependencies [70f2770]
  - @neurodesk/webapp-components@0.10.2
