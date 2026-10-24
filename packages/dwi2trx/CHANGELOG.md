# @neurodesk/dwi2trx

## 0.7.20261024

### Minor Changes

- 650ce5f: Share the DWI apps' input helpers. `@neurodesk/webapp-components/file-io/brain-mask` reads a user's brain mask (`readBrainMask`: decode, same grid as the image, one 3D volume, binarised) for noddi, n4 and the noddi command line, and `@neurodesk/webapp-components/volume/mean` holds `meanVolumes`. `@neurodesk/dwi2trx/gradients` adds `parseBval` (the bval half of `parseBvalBvec`, with an optional volume-count check), `B0_THRESHOLD`, `isB0` and `b0Volumes` (b < 50 s/mm², the rule of the `exes/dwi/gradients` crate, which a shared test case file now checks on both sides). dwidenoise and n4 parse their b-values with it, and dwidenoise's own `parseBvals` is removed. Outputs are unchanged; some bval error messages now use the shared wording.
- 25f296e: NODDI names the niimath build in its provenance when it fits the tensor with niimath dtifit, in the app and in the `noddi` command line. `@neurodesk/dwi2trx/niimath-version` gives the version of the pinned niimath build; DWI2TRX and the `dwi2trx` command line now read it from there.

### Patch Changes

- Updated dependencies [bd5f3a8]
  - @neurodesk/webapp-components@0.22.0
- Updated dependencies [941884c]
- Updated dependencies [a028e96]
- Updated dependencies [650ce5f]
- Updated dependencies [343c256]
- Updated dependencies [5b5ff35]
- Updated dependencies [941884c]
  - @neurodesk/webapp-components@0.21.0
  - @neurodesk/node-drivers@0.3.0

## 0.6.20261024

### Patch Changes

- Updated dependencies [3a7e5bb]
- Updated dependencies [72cbb8d]
  - @neurodesk/webapp-components@0.20.0
- Updated dependencies [3fc9cf2]
  - @neurodesk/webapp-components@0.19.1

## 0.6.20261022

### Patch Changes

- Updated dependencies [d32b485]
  - @neurodesk/webapp-components@0.19.0

## 0.6.20261020

### Minor Changes

- ccea86e: NODDI has a third tensor fit, niimath dtifit, in Advanced settings beside weighted least squares (the default) and ordinary least squares. It is FSL dtifit's default linear fit in the dtifit-enabled niimath build that DWI2TRX uses, and it runs in a Web Worker on the same volumes as the other fits: the b0 volumes and the shells up to b = 1200 s/mm². Its FA and MD are equal to DWI2TRX's fit of the same volumes, unit gradients and mask. niimath dtifit writes no AD or RD map, so AD is its first eigenvalue and RD is the mean of the second and third; where niimath sets MD to zero for a negative eigenvalue, AD and RD are zero too. The app gives niimath unit bvecs and runs it with `-xflip 0`, and the direction map gets the sign rule of the other fits, so FA, MD, AD, RD, S0 and the direction agree with the ordinary least squares fit on the same data. The maps keep their BIDS names, the provenance records `tensorFit: "niimath-dtifit"`, and the automation `tensorFit` parameter accepts `niimath-dtifit`. With NODDI selected, the NODDI fit runs after it.

  `@neurodesk/dwi2trx/runner` exports `runNiimath`, the browser's niimath runner on one cached module of the vendored dtifit build. The DWI2TRX tensor worker now imports it from the package instead of an app copy. `fitTensor` takes an optional `xflip` (`'0'`, `'1'` or `'auto'`), which goes to dtifit as `-xflip`; without it the argv does not change.

### Patch Changes

- d0df450: Rebuild the shared, file-pinned dtifit runtime from niimath cc26582a250c411b5c3c3c05c91dfd58f66be089 with Emscripten 6.0.13 so equal or nearly equal tensor eigenvalues retain unit, orthogonal directions. Record the source, toolchain, flags and licenses and cover the actual runtime with degenerate-tensor regressions. Re-record the production browser reference for V1–V3 because the repaired eigensolver changes the vectors and may reverse their arbitrary signs; scalar maps, tensor coefficients, the mask and every header remain byte identical.

- Keep tensor backend selection in NODDI's shared fitting pipeline. The command line accepts
  `--tensor-fit niimath-dtifit` and uses the same corrected vendored runtime, volume selection,
  map conversion and optional NODDI fit as the browser. Weighted least squares remains the default.

- Updated dependencies [a36fde4]

  - @neurodesk/webapp-components@0.18.0

- Updated dependencies

- Updated dependencies
  - @neurodesk/webapp-components@0.17.0

## 0.5.20261020

### Patch Changes

- Updated dependencies [c865c0c]
  - @neurodesk/webapp-components@0.17.1
- Updated dependencies [a36fde4]
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @neurodesk/webapp-components@0.17.0
- Updated dependencies [ea2a6d2]
- Updated dependencies [3f1d770]
- Updated dependencies [d9718cd]
- Updated dependencies [c1a4dda]
- Updated dependencies [3329c39]
- Updated dependencies [46935f7]

  - @neurodesk/webapp-components@0.16.0

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

- Updated dependencies [46935f7]

  - @neurodesk/webapp-components@0.16.0

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
- Updated dependencies [14db080]

- Updated dependencies [4b40da1]

- Updated dependencies
  - @neurodesk/webapp-components@0.17.2
- Updated dependencies
  - @neurodesk/webapp-components@0.17.1
- Updated dependencies [14db080]

## 0.5.20261019

### Patch Changes

- Updated dependencies [af2e8db]

- Updated dependencies [b3404ec]
  - @neurodesk/webapp-components@0.16.3

## 0.5.20261018

### Patch Changes

- Updated dependencies [b68209b]
  - @neurodesk/webapp-components@0.15.0
- Updated dependencies [2ae93ae]
- Updated dependencies [ccb2970]
- Updated dependencies [67a5a8f]

  - @neurodesk/webapp-components@0.14.4

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

- Updated dependencies [b68209b]

  - @neurodesk/webapp-components@0.15.0

- Updated dependencies [67a5a8f]

  - @neurodesk/webapp-components@0.14.4

- Updated dependencies [7c0d201]

  - @neurodesk/webapp-components@0.16.2

- Updated dependencies [46935f7]

  - @neurodesk/webapp-components@0.16.1

- Updated dependencies [3329c39]

  - @neurodesk/webapp-components@0.16.0

- Updated dependencies [b67e4e9]
  - @neurodesk/webapp-components@0.15.1

## 0.5.20261017

### Patch Changes

- Updated dependencies [b547d52]
  - @neurodesk/webapp-components@0.14.3

## 0.5.20261016

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.14.2
- Updated dependencies [7443048]

  - @neurodesk/webapp-components@0.14.1

- Updated dependencies

  - @neurodesk/webapp-components@0.14.2

- Updated dependencies [7443048]

  - @neurodesk/webapp-components@0.14.1

- Updated dependencies

  - @neurodesk/webapp-components@0.14.2

- Updated dependencies [7443048]
  - @neurodesk/webapp-components@0.14.1

## 0.5.20261015

### Patch Changes

- Updated dependencies [dd65e6a]
- Updated dependencies [dcc74e7]

  - @neurodesk/webapp-components@0.14.0

- Updated dependencies [dd65e6a]

- Updated dependencies [dcc74e7]
  - @neurodesk/webapp-components@0.14.0

## 0.5.20261014

### Patch Changes

- Updated dependencies [27c9549]
- Updated dependencies [850e642]
- Updated dependencies [ad92e2f]

  - @neurodesk/webapp-components@0.13.0

- Updated dependencies [27c9549]

- Updated dependencies [850e642]

- Updated dependencies [ad92e2f]
  - @neurodesk/webapp-components@0.13.0

## 0.5.20261012

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.12.3

## 0.5.20261010

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.12.2
- Move caller-pinned MindGrab and niimath Node drivers and their independent browser parity validation to dependency-free `@neurodesk/node-drivers`. Migrate every command line and remove the old runtime-support exports. Keep SynthSR and SynthStrip browser runtimes out of production Node deployments so portable brain-extraction and BrowserQC archives omit browser dependencies.
- Updated dependencies

  - @neurodesk/node-drivers@0.2.0
  - @neurodesk/webapp-components@0.12.1

- Updated dependencies

  - @neurodesk/webapp-components@0.12.2

- Move caller-pinned MindGrab and niimath Node drivers and their independent browser parity validation to dependency-free `@neurodesk/node-drivers`. Migrate every command line and remove the old runtime-support exports. Keep SynthSR and SynthStrip browser runtimes out of production Node deployments so portable brain-extraction and BrowserQC archives omit browser dependencies.

  - @neurodesk/node-drivers@0.2.0
  - @neurodesk/webapp-components@0.12.1

- Updated dependencies

  - @neurodesk/webapp-components@0.12.2

- Updated dependencies
  - @neurodesk/node-drivers@0.2.0
  - @neurodesk/webapp-components@0.12.1

## 0.5.20261009

### Minor Changes

- 18697e2: Add the `dwi2trx` command line for the tensor fit: `dwi2trx DWI BVAL BVEC OUTPUT_DIR [--mask FILE | --no-mask]` runs the web app's MindGrab brain mask (on the CPU) and `niimath --dtifit` with the same vendored WebAssembly build, and writes all eleven dtifit maps under the web app's download names. Tractography is not included, because it needs WebGPU with subgroups. The fit now lives in `@neurodesk/dwi2trx`, which the web app imports. The app moves to MindGrab 0.1.20260925. Its `fit` and `tractography` automation operations accept an optional brain `mask` input and return every dtifit map. Portable archives for Linux x64 and Windows x64 and a signed macOS installer run offline. Their release check fits the pinned example and requires every map to match the web app's own download voxel for voxel.

### Patch Changes

- Updated dependencies [66bf9e9]
- Updated dependencies [501ea0c]
- Updated dependencies [64ffefa]

  - @neurodesk/webapp-components@0.12.0
  - @neurodesk/runtime-support@0.3.0

- Updated dependencies [66bf9e9]

- Updated dependencies [501ea0c]

- Updated dependencies [64ffefa]
  - @neurodesk/webapp-components@0.12.0
  - @neurodesk/runtime-support@0.3.0
