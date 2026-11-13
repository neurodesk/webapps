# @neurodesk/seedseg

## 0.7.20261113

### Patch Changes

- Updated dependencies [3ae3eb4]
- Updated dependencies [3f0eab6]
  - @neurodesk/webapp-components@0.28.0
- 39acd6c: Reject a zero or non-finite voxel spacing in the NIfTI header with a clear error before bias correction, as upstream's `seedseg_onnx.py` now does. A zero or NaN spacing was previously read as 1 mm, and an infinite one failed inside resampling with `Invalid typed array length`.

## 0.7.20261112

## 0.7.20261111

### Patch Changes

- Updated dependencies [d643e8d]
- Updated dependencies [3beb743]
- Updated dependencies [a2675b9]
- Updated dependencies [8fca61b]
- Updated dependencies [83f5bb1]
- Updated dependencies [65a2e2b]
  - @neurodesk/webapp-components@0.27.0

## 0.7.20261110

## 0.7.20261109

### Patch Changes

- Updated dependencies [6ca6f49]
  - @neurodesk/webapp-components@0.26.0

## 0.7.20261108

### Patch Changes

- Updated dependencies [fbe693d]
- Updated dependencies [af1bc1e]
- Updated dependencies [7539ad5]
- Updated dependencies [aa722fe]
- Updated dependencies [8327887]
- Updated dependencies [6102c59]
  - @neurodesk/webapp-components@0.25.0

## 0.7.20261104

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.24.0

## 0.7.20261103

### Patch Changes

- Updated dependencies [491c3ce]
  - @neurodesk/webapp-components@0.23.0
- Updated dependencies [8e9346d]
- Updated dependencies [239dedd]
  - @neurodesk/webapp-components@0.22.4

## 0.7.20261102

## 0.7.20261031

### Patch Changes

- Updated dependencies [d8ac48c]
- Updated dependencies [b84a269]
  - @neurodesk/webapp-components@0.22.3

## 0.7.20261027

### Minor Changes

- 7019541: Integrate upstream nnU-Net v2 through the shared browser and command-line pipeline.
  Use pinned fold models, nonzero cropping, normalization, Gaussian sliding windows,
  optional mirroring, per-fold probability averaging and ranked marker detections.
  Default to network 1 without mirroring, with WebGPU first and WebAssembly fallback.
  Retain the legacy v1 consensus under Advanced and through explicit CLI options.
  Update ONNX Runtime to 1.30.0 and keep its loaders within the app service-worker scope.
  Keep the shared shell, model downloader, NIfTI helpers, progress and mask editing.
  Load the optional acquisition report on demand so an unavailable report host does
  not block segmentation. Add detection reports and browser/CLI parity coverage.

### Patch Changes

- Preserve WebAssembly fallback when a failed WebGPU session also rejects cleanup. Validate the five-fold ensemble and mirroring against WebAssembly on a verified hardware adapter in full Chromium.

## 0.6.20261027

### Patch Changes

- Use the checked-in Dicompare runtime during native/browser parity validation so an unrelated remote script outage cannot prevent the reference app from starting.
- Updated dependencies
  - @neurodesk/webapp-components@0.22.2
- Updated dependencies
  - @neurodesk/webapp-components@0.22.1

## 0.6.20261024

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

## 0.6.20261022

### Patch Changes

- Updated dependencies [d32b485]
  - @neurodesk/webapp-components@0.19.0

## 0.6.20261020

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

## 0.6.20261019

### Patch Changes

- Updated dependencies [af2e8db]

- Updated dependencies [b3404ec]
  - @neurodesk/webapp-components@0.16.3

## 0.6.20261018

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

## 0.6.20261017

### Patch Changes

- Updated dependencies [b547d52]
  - @neurodesk/webapp-components@0.14.3

## 0.6.20261016

### Patch Changes

- Updated dependencies

  - @neurodesk/webapp-components@0.14.2

- Updated dependencies [7443048]

  - @neurodesk/webapp-components@0.14.1

- Updated dependencies [7443048]
  - @neurodesk/webapp-components@0.14.1

## 0.6.20261015

### Patch Changes

- Updated dependencies [dd65e6a]

- Updated dependencies [dcc74e7]
  - @neurodesk/webapp-components@0.14.0

## 0.6.20261014

### Patch Changes

- Updated dependencies [27c9549]

- Updated dependencies [850e642]

- Updated dependencies [ad92e2f]
  - @neurodesk/webapp-components@0.13.0

## 0.6.20261012

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.12.3

## 0.6.20261010

### Minor Changes

- Share SeedSeg preprocessing, ensemble inference and marker selection between the browser and a portable CPU command line. Verify every checkpoint on download and cache load, include the four models and QSM runtime in offline archives, and validate native/browser masks against the existing positive synthetic localization fixture. Clinical-reference validation remains pending.

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.12.2
