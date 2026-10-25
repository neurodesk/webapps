# fastprep

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

- Updated dependencies [0066f60]
  - @neurodesk/webapp-components@0.21.1
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
