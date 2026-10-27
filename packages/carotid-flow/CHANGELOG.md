# @neurodesk/carotid-flow

## 0.4.20261027

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.22.1

## 0.4.20261025

## 0.4.20261024

### Patch Changes

- Updated dependencies [bd5f3a8, 0066f60]
  - @neurodesk/webapp-components@0.22.0
- Updated dependencies [941884c]
- Updated dependencies [a028e96]
- Updated dependencies [650ce5f]
- Updated dependencies [343c256]
- Updated dependencies [941884c]
  - @neurodesk/webapp-components@0.21.0
- Updated dependencies [3a7e5bb]
- Updated dependencies [72cbb8d]
  - @neurodesk/webapp-components@0.20.0
- Updated dependencies [3fc9cf2]
  - @neurodesk/webapp-components@0.19.1
- Updated dependencies
  - @neurodesk/webapp-components@0.21.1
- Updated dependencies [328cb77]
  - @neurodesk/webapp-components@0.20.1
- Updated dependencies [14a8b29]
- Updated dependencies [941884c]
  - @neurodesk/webapp-components@0.20.0
- Updated dependencies
  - @neurodesk/webapp-components@0.19.3
- Updated dependencies
  - @neurodesk/webapp-components@0.19.2

## 0.4.20261022

### Patch Changes

- Updated dependencies [d32b485]
  - @neurodesk/webapp-components@0.19.0

## 0.4.20261020

### Patch Changes

- Updated dependencies [c865c0c]
  - @neurodesk/webapp-components@0.17.1
- Updated dependencies [a36fde4]

  - @neurodesk/webapp-components@0.18.0

- Updated dependencies [14db080]

- Updated dependencies [03261d0]

- Updated dependencies [c865c0c]

  - @neurodesk/webapp-components@0.17.0

- Updated dependencies [ea2a6d2]

- Updated dependencies [3f1d770]

- Updated dependencies [d9718cd]

- Updated dependencies [c1a4dda]

- Updated dependencies [3329c39]

- Updated dependencies [46935f7]

  - @neurodesk/webapp-components@0.16.0

- Updated dependencies [d9718cd]

  - @neurodesk/webapp-components@0.16.3

- Updated dependencies [4b40da1]

  - @neurodesk/webapp-components@0.17.0

  - @neurodesk/webapp-components@0.16.3

- Updated dependencies [a36fde4]

- Updated dependencies

- Updated dependencies

  - @neurodesk/webapp-components@0.17.0

- Updated dependencies

  - @neurodesk/webapp-components@0.18.0

- Updated dependencies
  - @neurodesk/webapp-components@0.17.1
- Updated dependencies [4b40da1]

- Updated dependencies
  - @neurodesk/webapp-components@0.17.2
- Updated dependencies [14db080]

## 0.4.20261019

### Patch Changes

- Updated dependencies [af2e8db]

- Updated dependencies [b3404ec]
  - @neurodesk/webapp-components@0.16.3

## 0.4.20261018

### Patch Changes

- Updated dependencies [7c0d201]

  - @neurodesk/webapp-components@0.16.2

- Updated dependencies [46935f7]

  - @neurodesk/webapp-components@0.16.1

- Updated dependencies [ea2a6d2]

- Updated dependencies [0511cd7]

- Updated dependencies [3329c39]

  - @neurodesk/webapp-components@0.16.0

- Updated dependencies [b67e4e9]

  - @neurodesk/webapp-components@0.15.1

- Updated dependencies [b68209b]

  - @neurodesk/webapp-components@0.15.0

- Updated dependencies [2ae93ae]

- Updated dependencies [ccb2970]

- Updated dependencies [67a5a8f]

  - @neurodesk/webapp-components@0.14.4

- Updated dependencies [b67e4e9]
  - @neurodesk/webapp-components@0.15.1

## 0.4.20261017

### Patch Changes

- Updated dependencies [b547d52]
  - @neurodesk/webapp-components@0.14.3

## 0.4.20261016

### Patch Changes

- Updated dependencies

  - @neurodesk/webapp-components@0.14.2

- Updated dependencies [7443048]

  - @neurodesk/webapp-components@0.14.1

- Updated dependencies [7443048]
  - @neurodesk/webapp-components@0.14.1

## 0.4.20261015

### Patch Changes

- Updated dependencies [dd65e6a]

- Updated dependencies [dcc74e7]
  - @neurodesk/webapp-components@0.14.0

## 0.4.20261014

### Patch Changes

- Updated dependencies [27c9549]

- Updated dependencies [850e642]

- Updated dependencies [ad92e2f]
  - @neurodesk/webapp-components@0.13.0

## 0.4.20261012

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.12.3

## 0.4.20261010

### Patch Changes

- Updated dependencies

  - @neurodesk/webapp-components@0.12.2

  - @neurodesk/webapp-components@0.12.1

- Updated dependencies

  - @neurodesk/webapp-components@0.12.2

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

- Updated dependencies [70f2770]
  - @neurodesk/webapp-components@0.10.2
