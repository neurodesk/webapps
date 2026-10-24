# @neurodesk/edgereg

## 0.5.20261024

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.21.1
- Updated dependencies [941884c]
- Updated dependencies [a028e96]
- Updated dependencies [650ce5f]
- Updated dependencies [343c256]
- Updated dependencies [5b5ff35]
- Updated dependencies [941884c]
  - @neurodesk/webapp-components@0.21.0
  - @neurodesk/node-drivers@0.3.0
- Updated dependencies [3a7e5bb]
- Updated dependencies [72cbb8d]
  - @neurodesk/webapp-components@0.20.0
- Updated dependencies [3fc9cf2]
  - @neurodesk/webapp-components@0.19.1
- Updated dependencies [328cb77]
  - @neurodesk/webapp-components@0.20.1
- Updated dependencies [14a8b29]
- Updated dependencies [941884c]
  - @neurodesk/webapp-components@0.20.0
- Updated dependencies
  - @neurodesk/webapp-components@0.19.3
- Updated dependencies
- Updated dependencies [5b5ff35]
  - @neurodesk/webapp-components@0.19.2
  - @neurodesk/node-drivers@0.3.0

## 0.5.20261022

### Patch Changes

- Updated dependencies [d32b485]
  - @neurodesk/webapp-components@0.19.0

## 0.5.20261020

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

## 0.5.20261019

### Patch Changes

- Updated dependencies [af2e8db]

- Updated dependencies [b3404ec]
  - @neurodesk/webapp-components@0.16.3

## 0.5.20261018

### Patch Changes

- Updated dependencies [7c0d201]

  - @neurodesk/webapp-components@0.16.2

- Updated dependencies [46935f7]

  - @neurodesk/webapp-components@0.16.1

- Updated dependencies [ea2a6d2]

- Updated dependencies [0511cd7]

- Updated dependencies [3329c39]

  - @neurodesk/webapp-components@0.16.0

- Updated dependencies [3329c39]

  - @neurodesk/webapp-components@0.16.0

## 0.4.20261018

### Patch Changes

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

- Move caller-pinned MindGrab and niimath Node drivers and their independent browser parity validation to dependency-free `@neurodesk/node-drivers`. Migrate every command line and remove the old runtime-support exports. Keep SynthSR and SynthStrip browser runtimes out of production Node deployments so portable brain-extraction and BrowserQC archives omit browser dependencies.

  - @neurodesk/node-drivers@0.2.0
  - @neurodesk/webapp-components@0.12.1

- Updated dependencies
  - @neurodesk/node-drivers@0.2.0
  - @neurodesk/webapp-components@0.12.1

## 0.4.20261009

### Minor Changes

- 20e97ab: Add the `edgereg` command line: `edgereg MOVING FIXED OUTPUT_DIR [--robust-fov]` runs the web app's `register` operation in Node with the same niimath `-allineate` WebAssembly build, and writes the web app's download under the same name. The method now lives in `@neurodesk/edgereg`, which the web app imports. Portable archives for Linux x64 and Windows x64 and a signed macOS installer run offline. Their release check registers the pinned example and requires the output's header and voxels to hash identically to the web app's own download; native niimath built from source is held to measured limits.

### Patch Changes

- Updated dependencies [66bf9e9]

- Updated dependencies [501ea0c]

- Updated dependencies [64ffefa]
  - @neurodesk/webapp-components@0.12.0
  - @neurodesk/runtime-support@0.3.0
