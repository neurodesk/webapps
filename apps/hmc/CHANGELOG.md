# hmc

## 0.5.20261124

### Minor Changes

- f316dac: Migrate every MindGrab/MindMap/MindSnap app, package and Node driver from the preview `@brainchop/mindgrab` releases (`0.1.20260813`, `0.1.20260925`, `0.1.20261008`) to `@brainchop/core@1.0.0`.

  - Replaces `-gpu.wasm` binaries with `@brainchop/core`'s pure-JS WebGPU V4 runtime (`models/*.bin`, optional `shader-f16` with `f32` fallback, automatic `LowMem128` + paced Z-chunking), alongside updated WebGL2 (`glGetError` / `isContextLost()` checks) and threaded CPU WASM fallbacks.
  - Picks up explicit `inference-failed` errors on empty masks or degenerate segmentations, MindMap-18 v4.0 Gold, MindSnap-104 v4.0 Gold, MindMap-Fast v3.5 (`16chan18cls` alias), and coil-flare-safe conform (`f_high = 0.98`).
  - Unifies all shared MindGrab WASM binaries under `_runtime/mindgrab/1.0.0/` (`mindgrab-wasm-1-0-0`), strips duplicate bundled MindGrab weights/WASM from `ants`, `fireants`, `greedy`, `brain2print`, and `fastprep`, updates `brainchop-mindgrab` CLI options (`-v`/`--version`, `--no-turbo`), updates package/repository links to `neuroneural/brainchop-core`, and re-records all Chromium CPU validation baselines (MindGrab FreeSurfer SynthSeg Dice 0.9799).

### Patch Changes

- 94d6e09: In a browser that offers WebMCP, every app registers tools with the browser's built-in AI agent. The agent can read what the app does, load any of its examples, use the files you already opened or ask you to choose others, run any operation and wait for its report, run it again with other settings without asking for the files again, move and restyle the viewer, and save an output of the run it names. When it needs a decision, it asks you in a dialog that says an AI agent is asking, and closing the dialog declines. It uses files you opened in the app only after you confirm them in a dialog that lists them. It loads data from a web address only after you allow that address, the viewer gets that one file and not a redirect, and for a ZARRo store the dialog names the store's address, under which ZARRo then reads without following a redirect. It changes only how the viewer shows images, never their data or position, it never removes what the viewer shows unless the dialog says so, and it cannot capture the viewer or save images from it. When you use the page yourself, a request the agent already started does nothing more, and before it uses its files or the results of its latest run again it asks you in one dialog that names them and what that run was given, its files and the address it read; declining releases them. A dialog names what it asks about as it is when it opens, and if that changes before you allow it, it shows the change in place and asks again; loading the same example again is no change, and on the third change the dialog closes as declined. Escape, the close button and a click beside the dialog all decline, also after it showed a change. After you allow it, the agent gets that run's report and outputs exactly as the run ended, even if the page shows other results by then. Opening other files, picking an example or a handoff releases them at once, so it never runs on or reports an earlier examination by mistake. It can read what the viewer shows at any time, as you see it. Each app's Privacy dialog says what such an agent can read and do. Browsers without WebMCP load none of this. No browser enables WebMCP by default yet: Chrome offers it behind a testing flag, and each catalogue can hold an origin trial token for its host.

  Automation contracts can mark a parameter `required: true`. Easy MP2RAGE's acquisition values, QSMbly's echo times and field strength and micro-sam's prompts are now required, and the desktop contract schema and NeuroFlow tools accept and publish the mark.

- Updated dependencies [f316dac]
- Updated dependencies [dce0e7f]
- Updated dependencies [3364bea]
- Updated dependencies [94d6e09]
  - @neurodesk/runtime-support@0.10.0
  - @neurodesk/dwi2trx@0.9.20261124
  - @neurodesk/hmc@0.5.20261124
  - @neurodesk/webapp-components@0.29.0

## 0.4.20261119

### Patch Changes

- Updated dependencies [3db69e4]
  - @neurodesk/webapp-components@0.28.1
  - @neurodesk/dwi2trx@0.8.20261119
  - @neurodesk/hmc@0.4.20261119
  - @neurodesk/runtime-support@0.9.27

## 0.4.20261113

### Patch Changes

- Updated dependencies [3ae3eb4]
- Updated dependencies [3f0eab6]
- Updated dependencies [9312d3a]
  - @neurodesk/webapp-components@0.28.0
  - @neurodesk/runtime-support@0.9.26
  - @neurodesk/dwi2trx@0.8.20261113
  - @neurodesk/hmc@0.4.20261113
- @neurodesk/dwi2trx@0.8.20261113
- @neurodesk/hmc@0.4.20261113

## 0.4.20261112

### Patch Changes

- @neurodesk/dwi2trx@0.8.20261112
- @neurodesk/hmc@0.4.20261112

## 0.4.20261111

### Patch Changes

- Updated dependencies [d643e8d]
- Updated dependencies [3beb743]
- Updated dependencies [a2675b9]
- Updated dependencies [8fca61b]
- Updated dependencies [83f5bb1]
- Updated dependencies [65a2e2b]
  - @neurodesk/webapp-components@0.27.0
  - @neurodesk/dwi2trx@0.8.20261111
  - @neurodesk/hmc@0.4.20261111
  - @neurodesk/runtime-support@0.9.25

## 0.4.20261109

### Patch Changes

- Updated dependencies [6ca6f49]
  - @neurodesk/webapp-components@0.26.0
  - @neurodesk/dwi2trx@0.8.20261109
  - @neurodesk/hmc@0.4.20261109
  - @neurodesk/runtime-support@0.9.24

## 0.4.20261108

### Patch Changes

- Updated dependencies [fbe693d]
- Updated dependencies [af1bc1e]
- Updated dependencies [7539ad5]
- Updated dependencies [aa722fe]
- Updated dependencies [8327887]
- Updated dependencies [6102c59]
  - @neurodesk/webapp-components@0.25.0
  - @neurodesk/dwi2trx@0.8.20261108
  - @neurodesk/hmc@0.4.20261108
  - @neurodesk/runtime-support@0.9.23

## 0.4.20261104

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.24.0
  - @neurodesk/dwi2trx@0.8.20261104
  - @neurodesk/hmc@0.4.20261104
  - @neurodesk/runtime-support@0.9.22

## 0.4.20261103

### Patch Changes

- Updated dependencies [491c3ce]
  - @neurodesk/webapp-components@0.23.0
  - @neurodesk/dwi2trx@0.8.20261103
  - @neurodesk/hmc@0.4.20261103
  - @neurodesk/runtime-support@0.9.21
- Updated dependencies [8e9346d]
- Updated dependencies [1def103]
- Updated dependencies [239dedd]
  - @neurodesk/webapp-components@0.22.4
  - @neurodesk/hmc-registration@0.5.0
  - @neurodesk/dwi2trx@0.8.20261103
  - @neurodesk/hmc@0.4.20261103
  - @neurodesk/runtime-support@0.9.20

## 0.4.20261031

### Patch Changes

- Updated dependencies [f860d91]
- Updated dependencies [d8ac48c]
- Updated dependencies [b84a269]
  - @neurodesk/hmc-registration@0.4.0
  - @neurodesk/runtime-support@0.9.19
  - @neurodesk/webapp-components@0.22.3
  - @neurodesk/hmc@0.4.20261031
  - @neurodesk/dwi2trx@0.8.20261031

## 0.4.20261029

### Patch Changes

- 72861b0: Refuse inputs the motion model cannot hold, with a clear message, instead of failing with "unreachable": a series is checked when it loads (decoded size and DWI volume count), again for the selected model before automatic masking, and with the brain mask before the run. The estimate counts initialisation's whole-grid arrays and the GP prediction's buffers, is measured on the estimator's 1 GiB WebAssembly memory and is shared with the `hmc` command line.
- Updated dependencies [72861b0]
- Updated dependencies [f1ac9b2]
- Updated dependencies [ac283dd]
  - @neurodesk/hmc@0.4.20261029
  - @neurodesk/hmc-registration@0.3.1
  - @neurodesk/dwi2trx@0.8.20261029

## 0.4.20261027

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.22.2
  - @neurodesk/dwi2trx@0.8.20261027
  - @neurodesk/hmc@0.4.20261027
  - @neurodesk/runtime-support@0.9.18
- Updated dependencies
  - @neurodesk/webapp-components@0.22.1
  - @neurodesk/dwi2trx@0.8.20261027
  - @neurodesk/hmc@0.4.20261027
  - @neurodesk/runtime-support@0.9.17

## 0.4.20261025

### Patch Changes

- Updated dependencies [74b9c63]
  - @neurodesk/runtime-support@0.9.16
  - @neurodesk/dwi2trx@0.8.20261025
  - @neurodesk/hmc@0.4.20261025
- Updated dependencies [3226bb7]
  - @neurodesk/hmc-registration@0.3.0
  - @neurodesk/hmc@0.4.20261025
- @neurodesk/dwi2trx@0.8.20261025
- @neurodesk/hmc@0.4.20261025
- Updated dependencies [99037b6]
  - @neurodesk/runtime-support@0.9.15
  - @neurodesk/dwi2trx@0.8.20261025
  - @neurodesk/hmc@0.4.20261025
- ab5824c: Default the app, automation and command line to two registration workers based on the completed GP benchmark. Keep explicit worker overrides and the same default for both estimators.
- Updated dependencies [ab5824c]
  - @neurodesk/hmc@0.4.20261025

## 0.4.20261024

### Minor Changes

- 328cb77: Add a browser workspace and Node command line for GP and trivial diffusion head-motion correction, with pinned CPU brain masking, explicit worker controls, BIDS derivatives and effective-mask provenance. Verify the hosts against actual production-browser reference outputs.

### Patch Changes

- @neurodesk/dwi2trx@0.8.20261024
- @neurodesk/hmc@0.4.20261024
- 3e7ff03: Keep HMC's loaded files synchronized with page-drop routing and Undo. Serialize paired imports, preserve the last valid input after failures, and cancel pending imports together while retaining the prior mask. Cite MindGrab's method paper. Run the full pinned dmipy white-matter slab through production browser downloads in CI, with all 19 reference files verified by size and checksum.
  - @neurodesk/hmc@0.4.20261024
- Updated dependencies [ecaf40a]
  - @neurodesk/hmc@0.4.20261024
  - @neurodesk/dwi2trx@0.8.20261024
- cd75826: Bundle one registration kernel pair through the worker's existing URLs instead of staging a duplicate, and declare the scoped MindGrab runtime in the site registry.
- Updated dependencies
  - @neurodesk/webapp-components@0.21.1
  - @neurodesk/dwi2trx@0.8.20261024
  - @neurodesk/hmc@0.4.20261024
  - @neurodesk/runtime-support@0.9.14
- d73bb8b: Use the shared scan picker and DICOM conversion for supplied brain masks, rejecting selections containing more than one mask image.
  - @neurodesk/hmc@0.4.20261024
- 3e93e32: Restore the previous BIDS run selection when loading another run fails, preserving the retained input, supplied mask and completed results.
  - @neurodesk/hmc@0.4.20261024
- Updated dependencies [328cb77]
- Updated dependencies [14d97d8]
- Updated dependencies [25f296e]
  - @neurodesk/hmc@0.4.20261024
  - @neurodesk/webapp-components@0.20.1
  - @neurodesk/dwi2trx@0.8.20261024
  - @neurodesk/runtime-support@0.9.13
