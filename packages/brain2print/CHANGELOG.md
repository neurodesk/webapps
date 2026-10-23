# @neurodesk/brain2print

## 0.5.20261023

### Patch Changes

- Updated dependencies [3fc9cf2]
  - @neurodesk/webapp-components@0.19.1

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

## 0.5.20261015

### Patch Changes

- 0569da8: Add the `deface` command line. The defacing pipeline moves out of the web app into `@neurodesk/deface`, which the app and the command line share: niimath's affine `-deface` (fast or Hellinger, with or without robustfov) and MindGrab brain extraction (tight or with an 8 mm border). The command line runs the app's frozen BSD-2 niimath WebAssembly through `@neurodesk/node-drivers/niimath` and MindGrab's threaded CPU module through `@neurodesk/node-drivers/mindgrab`, writes the app's `defaced.nii` (and `brain-mask.nii` for MindGrab), and installs the MNI template and face mask with SHA-256 checks. It ships as portable Linux x64 and Windows x64 archives and a signed macOS arm64 installer. Each release must reproduce the app's pipeline as recorded in Chromium on the app's example: niimath output identical byte for byte and a MindGrab mask Dice of 0.99 or better.

  The web app now runs MindGrab from `@brainchop/mindgrab` 0.1.20260925 instead of its own WebGPU copy of the model. The weights are byte-identical; the package adds its own conform, normalisation and largest-component cleanup, and runs on a hardware GPU or, without one, the threaded CPU module, so MindGrab no longer needs `shader-f16`. The app stops downloading `net_mindgrab.safetensors`. `@neurodesk/runtime-support` gains `niimath/command`, which runs a niimath argv in the vendored worker, and `mindgrab`, the browser MindGrab runtime that Brain2Print used, which now lives there for both apps.

  Report niimath startup and worker failures through the operation's error state and start a fresh worker on retry. Keep Brain2Print's browser runtime out of its portable Node dependency tree and pin Deface's threaded CPU runtime inside its app service-worker scope.

  Store the browser's packed validation masks in the commit-pinned dataset instead of Git. Both validators download and reverify cached masks outside the source repository, and the recorder writes new masks outside it. Numerical output fingerprints and Dice requirements stay unchanged.

- Updated dependencies [dd65e6a]

- Updated dependencies [dcc74e7]
  - @neurodesk/webapp-components@0.14.0

## 0.5.20261014

### Patch Changes

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

  - @neurodesk/node-drivers@0.2.0
  - @neurodesk/webapp-components@0.12.1

- Updated dependencies

  - @neurodesk/webapp-components@0.12.2

- Updated dependencies
  - @neurodesk/node-drivers@0.2.0
  - @neurodesk/webapp-components@0.12.1

## 0.5.20261009

### Minor Changes

- 66bf9e9: Add the `brain2print` command line: `brain2print IMAGE OUTPUT_DIR` runs the web app's create-mesh operation in Node, with MindGrab on the CPU and the same niimath WebAssembly, and writes the web app's three downloads under the same names. Its options are the app's automation parameters: `--model`, `--backend` (the command line always runs on the CPU), `--simplify`, `--smooth`, `--[no-]largest-only` and `--[no-]fill-bubbles`. Portable archives for Linux x64 and Windows x64 and a signed macOS installer run offline. Their release check runs the app's pinned example, the template of the app's CPU e2e test and the right- and left-handed test fixtures, and requires every file to match the web pipeline's output in Chromium byte for byte; the app's CPU e2e test is held to the same pins.

  The app's pipeline moves into `@neurodesk/brain2print`, which the app and the command line share. The app now gives MindGrab NIfTI files as stored rather than as NiiVue rewrites them, and uses MindGrab 0.1.20260925. Breaking for `@neurodesk/topofit`: `readMz3`, `writeMz3` and `writeStl` are no longer exported from `@neurodesk/topofit/results`; import them from `@neurodesk/webapp-components/file-io/mesh`. The package is not published to npm and no workspace consumer imports them from TopoFit any more.

### Patch Changes

- Updated dependencies [66bf9e9]

- Updated dependencies [501ea0c]

- Updated dependencies [64ffefa]
  - @neurodesk/webapp-components@0.12.0
  - @neurodesk/runtime-support@0.3.0
