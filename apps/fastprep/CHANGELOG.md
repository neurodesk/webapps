# fastprep

## 0.3.20261124

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
- Updated dependencies [01e85d7]
- Updated dependencies [94d6e09]
  - @neurodesk/runtime-support@0.10.0
  - @neurodesk/fastprep@0.3.0
  - @neurodesk/sdc@0.6.20261124
  - @neurodesk/webapp-components@0.29.0
  - @neurodesk/greedy@0.10.20261124
  - @neurodesk/synthsr@0.6.20261124

## 0.2.20261119

### Patch Changes

- Updated dependencies [3db69e4]
  - @neurodesk/webapp-components@0.28.1
  - @neurodesk/fastprep@0.2.19
  - @neurodesk/runtime-support@0.9.27
  - @neurodesk/sdc@0.5.20261119
  - @neurodesk/synthsr@0.6.20261119
  - @neurodesk/greedy@0.9.20261119

## 0.2.20261113

### Patch Changes

- Updated dependencies [3ae3eb4]
- Updated dependencies [3f0eab6]
- Updated dependencies [9312d3a]
  - @neurodesk/webapp-components@0.28.0
  - @neurodesk/runtime-support@0.9.26
  - @neurodesk/synthsr@0.6.20261113
  - @neurodesk/fastprep@0.2.18
  - @neurodesk/sdc@0.5.20261113
  - @neurodesk/greedy@0.9.20261113
- @neurodesk/sdc@0.5.20261113
- @neurodesk/fastprep@0.2.17

## 0.2.20261112

### Patch Changes

- @neurodesk/sdc@0.5.20261112
- @neurodesk/fastprep@0.2.16

## 0.2.20261111

### Patch Changes

- Updated dependencies [d643e8d]
- Updated dependencies [3beb743]
- Updated dependencies [a2675b9]
- Updated dependencies [8fca61b]
- Updated dependencies [83f5bb1]
- Updated dependencies [65a2e2b]
  - @neurodesk/webapp-components@0.27.0
  - @neurodesk/greedy@0.9.20261111
  - @neurodesk/fastprep@0.2.15
  - @neurodesk/runtime-support@0.9.25
  - @neurodesk/sdc@0.5.20261111
  - @neurodesk/synthsr@0.6.20261111

## 0.2.20261109

### Patch Changes

- Updated dependencies [6ca6f49]
  - @neurodesk/webapp-components@0.26.0
  - @neurodesk/fastprep@0.2.14
  - @neurodesk/runtime-support@0.9.24
  - @neurodesk/sdc@0.5.20261109
  - @neurodesk/synthsr@0.6.20261109
  - @neurodesk/greedy@0.8.20261109

## 0.2.20261108

### Patch Changes

- Updated dependencies [fbe693d]
- Updated dependencies [af1bc1e]
- Updated dependencies [7539ad5]
- Updated dependencies [aa722fe]
- Updated dependencies [8327887]
- Updated dependencies [6102c59]
  - @neurodesk/webapp-components@0.25.0
  - @neurodesk/fastprep@0.2.13
  - @neurodesk/runtime-support@0.9.23
  - @neurodesk/sdc@0.5.20261108
  - @neurodesk/synthsr@0.6.20261108
  - @neurodesk/greedy@0.8.20261108

## 0.2.20261104

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.24.0
  - @neurodesk/fastprep@0.2.12
  - @neurodesk/runtime-support@0.9.22
  - @neurodesk/sdc@0.5.20261104
  - @neurodesk/synthsr@0.6.20261104
  - @neurodesk/greedy@0.8.20261104

## 0.2.20261103

### Patch Changes

- Updated dependencies [491c3ce]
  - @neurodesk/webapp-components@0.23.0
  - @neurodesk/sdc@0.5.20261103
  - @neurodesk/fastprep@0.2.11
  - @neurodesk/runtime-support@0.9.21
  - @neurodesk/synthsr@0.6.20261103
  - @neurodesk/greedy@0.8.20261103
- Updated dependencies [8e9346d]
- Updated dependencies [239dedd]
- Updated dependencies [9868d87]
- Updated dependencies [71881c8]
  - @neurodesk/webapp-components@0.22.4
  - @neurodesk/sdc@0.4.20261103
  - @neurodesk/fastprep@0.2.10
  - @neurodesk/runtime-support@0.9.20
  - @neurodesk/synthsr@0.6.20261103
  - @neurodesk/greedy@0.8.20261103

## 0.2.20261031

### Patch Changes

- Updated dependencies [d8ac48c]
- Updated dependencies [1a4882c]
- Updated dependencies [b84a269]
  - @neurodesk/runtime-support@0.9.19
  - @neurodesk/webapp-components@0.22.3
  - @neurodesk/greedy@0.8.20261031
  - @neurodesk/sdc@0.3.20261031
  - @neurodesk/synthsr@0.6.20261031
  - @neurodesk/fastprep@0.2.9

## 0.2.20261029

### Patch Changes

- Updated dependencies [4761b2c]
- Updated dependencies [4761b2c]
  - @neurodesk/fastprep@0.2.8
  - @neurodesk/greedy@0.7.20261029
  - @neurodesk/sdc@0.3.20261029

## 0.2.20261027

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.22.2
  - @neurodesk/fastprep@0.2.7
  - @neurodesk/runtime-support@0.9.18
  - @neurodesk/sdc@0.3.20261027
  - @neurodesk/synthsr@0.6.20261027
  - @neurodesk/greedy@0.6.20261027
- Updated dependencies
  - @neurodesk/webapp-components@0.22.1
  - @neurodesk/fastprep@0.2.6
  - @neurodesk/runtime-support@0.9.17
  - @neurodesk/sdc@0.3.20261027
  - @neurodesk/synthsr@0.6.20261027
  - @neurodesk/greedy@0.6.20261027

## 0.2.20261025

### Patch Changes

- Updated dependencies [74b9c63]
- Updated dependencies [4bc35f7]
  - @neurodesk/runtime-support@0.9.16
  - @neurodesk/sdc@0.3.20261025
  - @neurodesk/synthsr@0.6.20261025
  - @neurodesk/fastprep@0.2.5
  - @neurodesk/greedy@0.6.20261025
- Updated dependencies [99037b6]
  - @neurodesk/runtime-support@0.9.15
  - @neurodesk/synthsr@0.6.20261025
  - @neurodesk/greedy@0.6.20261025
  - @neurodesk/sdc@0.2.20261025
  - @neurodesk/fastprep@0.2.4

## 0.2.20261024

### Minor Changes

- Estimate PEPOLAR fields from validated reverse phase-encoding EPI references using the existing PyHySCO solver, with a lazy browser runtime and Jacobian-modulated BOLD correction. Preserve phasediff processing and document the deliberate difference from Python's SuCor method.

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.21.1
  - @neurodesk/fastprep@0.2.3
  - @neurodesk/runtime-support@0.9.14
  - @neurodesk/synthsr@0.6.20261024
  - @neurodesk/greedy@0.6.20261024
  - @neurodesk/sdc@0.2.20261024
- Updated dependencies [328cb77]
  - @neurodesk/webapp-components@0.20.1
  - @neurodesk/fastprep@0.2.2
  - @neurodesk/runtime-support@0.9.13
  - @neurodesk/synthsr@0.6.20261024
  - @neurodesk/greedy@0.6.20261024
  - @neurodesk/sdc@0.2.20261024
- Document the decision not to offer ANTs reverse-PE correction after its six-subject image-gate failure, without implying single-PE ANTs is available. Keep About content in the canonical registry. Correct fastprep's browser PEPOLAR description and bundled GPL solver license metadata.
  - @neurodesk/sdc@0.2.20261024
  - @neurodesk/fastprep@0.2.1
- Updated dependencies
  - @neurodesk/fastprep@0.2.0

## 0.1.20261024

### Patch Changes

- Updated dependencies [bd5f3a8, 0066f60]
  - @neurodesk/webapp-components@0.22.0
  - @neurodesk/runtime-support@0.9.12
  - @neurodesk/synthsr@0.6.20261024
  - @neurodesk/greedy@0.6.20261024
- Updated dependencies [941884c]
- Updated dependencies [a028e96]
- Updated dependencies [650ce5f]
- Updated dependencies [343c256]
- Updated dependencies [941884c]
  - @neurodesk/webapp-components@0.21.0
  - @neurodesk/runtime-support@0.9.11
  - @neurodesk/fastprep@0.1.20261018
  - @neurodesk/synthsr@0.6.20261024
  - @neurodesk/greedy@0.6.20261024
- Updated dependencies [3a7e5bb]
- Updated dependencies [72cbb8d]
  - @neurodesk/webapp-components@0.20.0
  - @neurodesk/runtime-support@0.9.10
  - @neurodesk/synthsr@0.6.20261024
  - @neurodesk/greedy@0.6.20261024
- Updated dependencies [3fc9cf2]
  - @neurodesk/webapp-components@0.19.1
  - @neurodesk/runtime-support@0.9.9
  - @neurodesk/synthsr@0.6.20261024
  - @neurodesk/greedy@0.6.20261024
- Updated dependencies [14a8b29]
- Updated dependencies [941884c]
  - @neurodesk/webapp-components@0.20.0
  - @neurodesk/runtime-support@0.9.12
  - @neurodesk/synthsr@0.6.20261024
  - @neurodesk/greedy@0.6.20261024
- Updated dependencies
  - @neurodesk/webapp-components@0.19.3
  - @neurodesk/runtime-support@0.9.11
  - @neurodesk/synthsr@0.6.20261024
  - @neurodesk/greedy@0.6.20261024
- Updated dependencies
  - @neurodesk/webapp-components@0.19.2
  - @neurodesk/synthsr@0.6.20261024
  - @neurodesk/runtime-support@0.9.10
  - @neurodesk/fastprep@0.1.20261018
  - @neurodesk/greedy@0.6.20261024

## 0.1.20261022

### Patch Changes

- Updated dependencies [d32b485]
  - @neurodesk/webapp-components@0.19.0
  - @neurodesk/runtime-support@0.9.8
  - @neurodesk/synthsr@0.6.20261022
  - @neurodesk/greedy@0.6.20261022
- c93ed0b: Denoise runs with three or more echoes with ME-ICA (meica, a Rust port of tedana): components are classified on the motion- and distortion-corrected echoes and the rejected ones regressed from each preprocessed series (`desc-denoised`). The report adds a Multi-echo ICA section and runs the task GLM on both series. Adds a pinned multi-echo example.

  Reject undeclared ME-ICA browser options, extra scalar values and missing option values.

- Updated dependencies [c93ed0b]
  - @neurodesk/fastprep@0.1.20261018

## 0.1.20261020

### Patch Changes

- Updated dependencies
  - @neurodesk/runtime-support@0.9.7
  - @neurodesk/synthsr@0.6.20261020
  - @neurodesk/greedy@0.6.20261020
- Updated dependencies [c865c0c]
  - @neurodesk/webapp-components@0.17.1
  - @neurodesk/runtime-support@0.8.2
  - @neurodesk/synthsr@0.6.20261020
  - @neurodesk/greedy@0.6.20261020
- Updated dependencies [a36fde4]
- Updated dependencies
- Updated dependencies
  - @neurodesk/webapp-components@0.17.0
  - @neurodesk/runtime-support@0.8.1
  - @neurodesk/synthsr@0.6.20261020
  - @neurodesk/greedy@0.6.20261020
- 3d1feee: The technical log now shows MindGrab's own output for the brain extraction and tissue segmentation steps: which backend ran (WebGPU, WebGL2 or CPU), its timing, and warnings such as "the network found no brain". Before, a failed step reported only "the mindmap module exited with status 1".

  The desktop suite's hosted runners no longer run fastprep's offline workflow: their software WebGL2 gives MindGrab a blank brain and ends the tissue segmentation with status 1. fastprep joins the apps whose workflow is validated on a hardware GPU, as its registry entry already declares.

- 14b8248: MindGrab's automatic backend no longer runs WebGL2 on a software renderer (SwiftShader, llvmpipe), which returned a blank brain mask without WebGPU; the threaded CPU module runs instead. The choice and MindGrab's own output appear in the technical log.
- d1fa022: SynthSR no longer runs on a software WebGPU adapter. fastprep chooses WebAssembly when the adapter is a fallback (SwiftShader on a VM or a hosted runner) or cannot bind the volume's largest buffer, and the SynthSR app starts on CPU there. The GPU buffer-limit message gives both sizes in MiB, so a need just above the limit no longer reads as "1.0 GiB but this device allows 1.0 GiB".
- Updated dependencies [ea2a6d2]
- Updated dependencies [3f1d770]
- Updated dependencies [14b8248]
- Updated dependencies [d9718cd]
- Updated dependencies [c1a4dda]
- Updated dependencies [1f4aecd]
- Updated dependencies [3329c39]
- Updated dependencies [46935f7]
- Updated dependencies [d1fa022]

  - @neurodesk/webapp-components@0.16.0
  - @neurodesk/runtime-support@0.8.0
  - @neurodesk/synthsr@0.6.20261020
  - @neurodesk/greedy@0.6.20261020

- @neurodesk/synthsr@0.6.20261020

- Updated dependencies [a36fde4]

  - @neurodesk/webapp-components@0.18.0
  - @neurodesk/runtime-support@0.9.5
  - @neurodesk/synthsr@0.6.20261020
  - @neurodesk/greedy@0.6.20261020

- Updated dependencies [14db080]

- Updated dependencies [03261d0]

- Updated dependencies [c865c0c]

  - @neurodesk/webapp-components@0.17.0
  - @neurodesk/runtime-support@0.9.4
  - @neurodesk/synthsr@0.6.20261020
  - @neurodesk/greedy@0.6.20261020

- 3d1feee: The technical log now shows MindGrab's own output for the brain extraction and tissue segmentation steps: which backend ran (WebGPU, WebGL2 or CPU), its timing, and warnings such as "the network found no brain". Before, a failed step reported only "the mindmap module exited with status 1".

- 14b8248: MindGrab's automatic backend no longer runs WebGL2 on a software renderer (SwiftShader, llvmpipe), which returned a blank brain mask without WebGPU; the threaded CPU module runs instead. The choice and MindGrab's own output appear in the technical log.

- d1fa022: SynthSR no longer runs on a software WebGPU adapter. fastprep chooses WebAssembly when the adapter is a fallback (SwiftShader on a VM or a hosted runner) or cannot bind the volume's largest buffer, and the SynthSR app starts on CPU there. The GPU buffer-limit message gives both sizes in MiB, so a need just above the limit no longer reads as "1.0 GiB but this device allows 1.0 GiB".

- Updated dependencies [ea2a6d2]

- Updated dependencies [3f1d770]

- Updated dependencies [14b8248]

- Updated dependencies [d9718cd]

- Updated dependencies [c1a4dda]

- Updated dependencies [1f4aecd]

- Updated dependencies [3329c39]

- Updated dependencies [46935f7]

- Updated dependencies [d1fa022]

  - @neurodesk/webapp-components@0.16.3
  - @neurodesk/runtime-support@0.9.3
  - @neurodesk/synthsr@0.6.20261020
  - @neurodesk/greedy@0.6.20261020

- Updated dependencies [4b40da1]

  - @neurodesk/webapp-components@0.17.0
  - @neurodesk/runtime-support@0.9.4
  - @neurodesk/synthsr@0.6.20261020
  - @neurodesk/greedy@0.6.20261020

  - @neurodesk/webapp-components@0.16.3
  - @neurodesk/runtime-support@0.9.3
  - @neurodesk/synthsr@0.6.20261020
  - @neurodesk/greedy@0.6.20261020

- Updated dependencies [a36fde4]

- Updated dependencies

- Updated dependencies

  - @neurodesk/webapp-components@0.17.0
  - @neurodesk/runtime-support@0.8.1
  - @neurodesk/synthsr@0.6.20261020
  - @neurodesk/greedy@0.6.20261020

- Updated dependencies

  - @neurodesk/webapp-components@0.18.0
  - @neurodesk/runtime-support@0.8.2
  - @neurodesk/synthsr@0.6.20261020
  - @neurodesk/greedy@0.6.20261020

- Updated dependencies
  - @neurodesk/runtime-support@0.9.5
  - @neurodesk/webapp-components@0.17.1
  - @neurodesk/synthsr@0.6.20261020
  - @neurodesk/greedy@0.6.20261020
- Updated dependencies [4b40da1]

- Updated dependencies
  - @neurodesk/webapp-components@0.17.2
  - @neurodesk/runtime-support@0.9.6
  - @neurodesk/synthsr@0.6.20261020
  - @neurodesk/greedy@0.6.20261020
- Updated dependencies [14db080]

## 0.1.20261019

### Patch Changes

- Updated dependencies [af2e8db]

- Updated dependencies [b3404ec]

  - @neurodesk/webapp-components@0.16.3
  - @neurodesk/runtime-support@0.9.3
  - @neurodesk/synthsr@0.6.20261019
  - @neurodesk/greedy@0.6.20261019

- da2584b: SynthSR no longer runs on a software WebGPU adapter. fastprep chooses WebAssembly when the adapter is a fallback (SwiftShader on a VM or a hosted runner) or cannot bind the volume's largest buffer, and the SynthSR app starts on CPU there. The GPU buffer-limit message gives both sizes in MiB, so a need just above the limit no longer reads as "1.0 GiB but this device allows 1.0 GiB".

- Updated dependencies [da2584b]
  - @neurodesk/synthsr@0.6.20261019
  - @neurodesk/runtime-support@0.9.2
  - @neurodesk/greedy@0.6.20261019

## 0.1.20261018

### Minor Changes

- 1c11f1c: New app: fastprep, fMRI preprocessing of one BIDS subject in the browser (Rust/WASM port of fastprep.py with greedy, niimath, MindGrab, SynthSR and glm), with an HTML report and zipped derivatives. Drop a BIDS folder anywhere on the page, or choose one from the input menu.

  Reject invalid BOLD repetition times and nonfinite confounds, escape report metadata, rerun the GLM when its BOLD sidecar changes, and restore example inputs through page-drop Undo.

### Patch Changes

- Updated dependencies [b68209b]
  - @neurodesk/webapp-components@0.15.0
  - @neurodesk/runtime-support@0.7.1
  - @neurodesk/synthsr@0.6.20261018
  - @neurodesk/greedy@0.5.20261018
- Updated dependencies [67a5a8f]
- Updated dependencies [b8b37d6]
- Updated dependencies [2ae93ae]
- Updated dependencies [ccb2970]
- Updated dependencies [67a5a8f]
  - @neurodesk/runtime-support@0.7.0
  - @neurodesk/webapp-components@0.14.4
  - @neurodesk/synthsr@0.6.20261018
  - @neurodesk/greedy@0.5.20261018
- Stop preprocessing workers when automation cancels a run, restore the Run action, and keep completed runs from affecting later work. Build the required scientific runtimes before standalone browser tests, synchronize the GPU slot test on lock acquisition, and add Greedy and GLM method citations.
- Updated dependencies [1c11f1c]

  - @neurodesk/fastprep@0.1.20261017

- Updated dependencies [7c0d201]

  - @neurodesk/webapp-components@0.16.2
  - @neurodesk/runtime-support@0.9.1
  - @neurodesk/synthsr@0.6.20261018
  - @neurodesk/greedy@0.6.20261018

- @neurodesk/greedy@0.6.20261018

- 3d1feee: The technical log now shows MindGrab's own output for the brain extraction and tissue segmentation steps: which backend ran (WebGPU, WebGL2 or CPU), its timing, and warnings such as "the network found no brain". Before, a failed step reported only "the mindmap module exited with status 1".

  The desktop suite's hosted runners no longer run fastprep's offline workflow: their software WebGL2 gives MindGrab a blank brain and ends the tissue segmentation with status 1. fastprep joins the apps whose workflow is validated on a hardware GPU, as its registry entry already declares.

- Updated dependencies

- Updated dependencies [46935f7]

  - @neurodesk/runtime-support@0.9.0
  - @neurodesk/webapp-components@0.16.1
  - @neurodesk/synthsr@0.6.20261018
  - @neurodesk/greedy@0.6.20261018

- Updated dependencies [ea2a6d2]

- Updated dependencies [0511cd7]

- Updated dependencies [a07f659]

- Updated dependencies [3329c39]

  - @neurodesk/webapp-components@0.16.0
  - @neurodesk/runtime-support@0.8.0
  - @neurodesk/synthsr@0.6.20261018
  - @neurodesk/greedy@0.6.20261018

- Updated dependencies [b67e4e9]

  - @neurodesk/runtime-support@0.7.2
  - @neurodesk/webapp-components@0.15.1
  - @neurodesk/synthsr@0.6.20261018
  - @neurodesk/greedy@0.5.20261018

- Updated dependencies [b68209b]

  - @neurodesk/webapp-components@0.15.0
  - @neurodesk/runtime-support@0.7.1
  - @neurodesk/synthsr@0.6.20261018
  - @neurodesk/greedy@0.5.20261018

- Updated dependencies [67a5a8f]

- Updated dependencies [b8b37d6]

- Updated dependencies [2ae93ae]

- Updated dependencies [ccb2970]

  - @neurodesk/runtime-support@0.7.0
  - @neurodesk/webapp-components@0.14.4
  - @neurodesk/synthsr@0.6.20261018
  - @neurodesk/greedy@0.5.20261018

- Stop preprocessing workers when automation cancels a run, restore the Run action, and keep completed runs from affecting later work. Build the required scientific runtimes before standalone browser tests, synchronize the GPU slot test on lock acquisition, and add Greedy and GLM method citations.

- Updated dependencies [67a5a8f]

  - @neurodesk/runtime-support@0.7.0
  - @neurodesk/webapp-components@0.14.4
  - @neurodesk/synthsr@0.6.20261018
  - @neurodesk/greedy@0.5.20261018

- Updated dependencies [b67e4e9]
  - @neurodesk/runtime-support@0.7.2
  - @neurodesk/webapp-components@0.15.1
  - @neurodesk/synthsr@0.6.20261018
  - @neurodesk/greedy@0.5.20261018
