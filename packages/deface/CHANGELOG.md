# @neurodesk/deface

## 1.5.20261124

### Minor Changes

- f316dac: Migrate every MindGrab/MindMap/MindSnap app, package and Node driver from the preview `@brainchop/mindgrab` releases (`0.1.20260813`, `0.1.20260925`, `0.1.20261008`) to `@brainchop/core@1.0.0`.

  - Replaces `-gpu.wasm` binaries with `@brainchop/core`'s pure-JS WebGPU V4 runtime (`models/*.bin`, optional `shader-f16` with `f32` fallback, automatic `LowMem128` + paced Z-chunking), alongside updated WebGL2 (`glGetError` / `isContextLost()` checks) and threaded CPU WASM fallbacks.
  - Picks up explicit `inference-failed` errors on empty masks or degenerate segmentations, MindMap-18 v4.0 Gold, MindSnap-104 v4.0 Gold, MindMap-Fast v3.5 (`16chan18cls` alias), and coil-flare-safe conform (`f_high = 0.98`).
  - Unifies all shared MindGrab WASM binaries under `_runtime/mindgrab/1.0.0/` (`mindgrab-wasm-1-0-0`), strips duplicate bundled MindGrab weights/WASM from `ants`, `fireants`, `greedy`, `brain2print`, and `fastprep`, updates `brainchop-mindgrab` CLI options (`-v`/`--version`, `--no-turbo`), updates package/repository links to `neuroneural/brainchop-core`, and re-records all Chromium CPU validation baselines (MindGrab FreeSurfer SynthSeg Dice 0.9799).

### Patch Changes

- Updated dependencies [f316dac]
- Updated dependencies [01e85d7]
- Updated dependencies [dce0e7f]
  - @neurodesk/runtime-support@0.10.0
  - @neurodesk/node-drivers@0.4.0

## 1.4.20261119

### Patch Changes

- @neurodesk/runtime-support@0.9.27

## 1.4.20261113

### Patch Changes

- Updated dependencies [9312d3a]
  - @neurodesk/runtime-support@0.9.26

## 1.4.20261111

### Patch Changes

- @neurodesk/runtime-support@0.9.25

## 1.4.20261109

### Patch Changes

- @neurodesk/runtime-support@0.9.24

## 1.4.20261108

### Patch Changes

- @neurodesk/runtime-support@0.9.23

## 1.4.20261104

### Patch Changes

- @neurodesk/runtime-support@0.9.22

## 1.4.20261103

### Patch Changes

- @neurodesk/runtime-support@0.9.21
- Updated dependencies [71881c8]
  - @neurodesk/node-drivers@0.3.2
  - @neurodesk/runtime-support@0.9.20

## 1.4.20261031

### Patch Changes

- Updated dependencies [d8ac48c]
  - @neurodesk/runtime-support@0.9.19
  - @neurodesk/node-drivers@0.3.1

## 1.4.20261027

### Patch Changes

- @neurodesk/runtime-support@0.9.18
- @neurodesk/runtime-support@0.9.17

## 1.4.20261025

### Patch Changes

- Updated dependencies [74b9c63]
  - @neurodesk/runtime-support@0.9.16
- Updated dependencies [99037b6]
  - @neurodesk/runtime-support@0.9.15

## 1.4.20261024

### Patch Changes

- @neurodesk/runtime-support@0.9.12
- Updated dependencies [5b5ff35]
  - @neurodesk/node-drivers@0.3.0
  - @neurodesk/runtime-support@0.9.11
- @neurodesk/runtime-support@0.9.10
- @neurodesk/runtime-support@0.9.9
- @neurodesk/runtime-support@0.9.14
- @neurodesk/runtime-support@0.9.13
- @neurodesk/runtime-support@0.9.11
- Updated dependencies [5b5ff35]
  - @neurodesk/node-drivers@0.3.0
  - @neurodesk/runtime-support@0.9.10

## 1.4.20261022

### Patch Changes

- @neurodesk/runtime-support@0.9.8

## 1.4.20261020

### Patch Changes

- Updated dependencies
  - @neurodesk/runtime-support@0.9.7
- @neurodesk/runtime-support@0.8.2
- @neurodesk/runtime-support@0.8.1
- Updated dependencies [14b8248]
- Updated dependencies [c1a4dda]
- Updated dependencies [1f4aecd]
- Updated dependencies [d1fa022]

  - @neurodesk/runtime-support@0.8.0

- @neurodesk/runtime-support@0.9.5

- @neurodesk/runtime-support@0.9.4

- Updated dependencies [14b8248]

- Updated dependencies [c1a4dda]

- Updated dependencies [1f4aecd]

- Updated dependencies [d1fa022]

  - @neurodesk/runtime-support@0.9.3

- Updated dependencies [d1fa022]

  - @neurodesk/runtime-support@0.8.0

  - @neurodesk/runtime-support@0.9.3

- @neurodesk/runtime-support@0.8.1

- @neurodesk/runtime-support@0.8.2

- Updated dependencies
  - @neurodesk/runtime-support@0.9.5
- Updated dependencies
  - @neurodesk/runtime-support@0.9.6
- @neurodesk/runtime-support@0.9.4

## 1.4.20261019

### Patch Changes

- @neurodesk/runtime-support@0.9.3

- Updated dependencies [da2584b]
  - @neurodesk/runtime-support@0.9.2

## 1.4.20261018

### Patch Changes

- Updated dependencies [b68209b]
  - @neurodesk/runtime-support@0.7.1
- 45ae49a: Remove verified dead code from the unused-code report (#256): dicompare's unused technical-log helpers, QSMbly's duplicate `QsmEchoViewer` export and Deface's unused `@neurodesk/webapp-components` devDependency. The calmar and SCT task tests now import the modules they check by literal path.
- Updated dependencies [67a5a8f]
- Updated dependencies [b8b37d6]

  - @neurodesk/runtime-support@0.7.0

- @neurodesk/runtime-support@0.9.1

- Updated dependencies

  - @neurodesk/runtime-support@0.9.0

- Updated dependencies [0511cd7]

- Updated dependencies [a07f659]

  - @neurodesk/runtime-support@0.8.0

- Updated dependencies [b67e4e9]

  - @neurodesk/runtime-support@0.7.2

- Updated dependencies [b68209b]

  - @neurodesk/runtime-support@0.7.1

- 45ae49a: Remove verified dead code from the unused-code report (#256): dicompare's unused technical-log helpers, QSMbly's duplicate `QsmEchoViewer` export and Deface's unused `@neurodesk/webapp-components` devDependency. The calmar and SCT task tests now import the modules they check by literal path.

- Updated dependencies [67a5a8f]

- Updated dependencies [b67e4e9]
  - @neurodesk/runtime-support@0.7.2

## 1.4.20261017

### Patch Changes

- @neurodesk/runtime-support@0.6.4

## 1.4.20261016

### Patch Changes

- Updated dependencies
  - @neurodesk/runtime-support@0.6.3
- @neurodesk/runtime-support@0.6.2

- Updated dependencies

  - @neurodesk/runtime-support@0.6.3

- Updated dependencies

  - @neurodesk/runtime-support@0.6.3

## 1.4.20261015

### Minor Changes

- 0569da8: Add the `deface` command line. The defacing pipeline moves out of the web app into `@neurodesk/deface`, which the app and the command line share: niimath's affine `-deface` (fast or Hellinger, with or without robustfov) and MindGrab brain extraction (tight or with an 8 mm border). The command line runs the app's frozen BSD-2 niimath WebAssembly through `@neurodesk/node-drivers/niimath` and MindGrab's threaded CPU module through `@neurodesk/node-drivers/mindgrab`, writes the app's `defaced.nii` (and `brain-mask.nii` for MindGrab), and installs the MNI template and face mask with SHA-256 checks. It ships as portable Linux x64 and Windows x64 archives and a signed macOS arm64 installer. Each release must reproduce the app's pipeline as recorded in Chromium on the app's example: niimath output identical byte for byte and a MindGrab mask Dice of 0.99 or better.

  The web app now runs MindGrab from `@brainchop/mindgrab` 0.1.20260925 instead of its own WebGPU copy of the model. The weights are byte-identical; the package adds its own conform, normalisation and largest-component cleanup, and runs on a hardware GPU or, without one, the threaded CPU module, so MindGrab no longer needs `shader-f16`. The app stops downloading `net_mindgrab.safetensors`. `@neurodesk/runtime-support` gains `niimath/command`, which runs a niimath argv in the vendored worker, and `mindgrab`, the browser MindGrab runtime that Brain2Print used, which now lives there for both apps.

  Report niimath startup and worker failures through the operation's error state and start a fresh worker on retry. Keep Brain2Print's browser runtime out of its portable Node dependency tree and pin Deface's threaded CPU runtime inside its app service-worker scope.

  Store the browser's packed validation masks in the commit-pinned dataset instead of Git. Both validators download and reverify cached masks outside the source repository, and the recorder writes new masks outside it. Numerical output fingerprints and Dice requirements stay unchanged.

### Patch Changes

- Updated dependencies [c74b26f]
  - @neurodesk/runtime-support@0.6.1
- a1a9b25: Let Deface archive validation use the launcher's bundled model directory instead
  of supplying an empty temporary override. Source validation retains its temporary
  template cache, and explicit model-directory overrides remain respected.
- Updated dependencies [0569da8]

  - @neurodesk/runtime-support@0.6.0

- Updated dependencies [c74b26f]

  - @neurodesk/runtime-support@0.6.1

- a1a9b25: Let Deface archive validation use the launcher's bundled model directory instead
  of supplying an empty temporary override. Source validation retains its temporary
  template cache, and explicit model-directory overrides remain respected.

- Updated dependencies [0569da8]
  - @neurodesk/runtime-support@0.6.0
