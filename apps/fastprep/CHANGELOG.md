# fastprep

## 0.1.20261020

### Patch Changes

- Updated dependencies
- Updated dependencies
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
