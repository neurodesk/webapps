# @neurodesk/greedy

## 0.8.20261031

### Minor Changes

- 1a4882c: greedy-rs registers with Greedy's neighbourhood cross-correlation for stationary-velocity warps: `-m NCC 2x2x2` (any radius) on the command line, `register_svf_masked_wasm` with metric `NCC 2x2x2` in WebAssembly and `registerSvfGreedy` in JavaScript. Its gradient is the exact one of Greedy's unweighted NCC. On five T1-to-ICBM 2009c registrations it matched Greedy 1.4's correlation to within 0.004. Unlike Greedy, it adds no random noise to the images, so its results stay deterministic.

## 0.7.20261029

### Patch Changes

- 4761b2c: Fix the masked (`-gm`) NMI affine diverging on a whole-head T1 to template pair (#623). The fixed pyramid now applies Greedy's masked downsampling, so the masked objective matches Greedy's, and the command line starts from the physical identity unless `-ia-image-centers` is given, as Greedy does; the WebAssembly affine functions take that choice as an argument and the app wrappers keep starting from image centres.

## 0.6.20261027

## 0.6.20261025

## 0.6.20261024

## 0.6.20261022

## 0.6.20261020

## 0.6.20261019

## 0.6.20261018

## 0.5.20261018

## 0.5.20261017

## 0.5.20261016

## 0.5.20261015

## 0.5.20261014

## 0.5.20261012

## 0.4.20261010

## 0.4.20261009

## 0.4.20261007

## 0.4.20261004

## 0.4.20261003

## 0.4.20260930

## 0.4.20260928

## 0.3.20260928

## 0.3.20260924

## 0.3.20260923

## 0.3.20260920

## 0.3.20260918

## 0.3.20260916

## 0.3.20260915

## 0.2.20260914

### Minor Changes

- Add offline Greedy native packaging for Linux x64, Windows x64 and Apple ARM, with an isolated signed and notarized macOS installer release. Add an npm-installable CLI that bundles native binaries and validates installed packages on each target. Document the catalog-wide CLI rollout and remaining pipeline ports.

## 0.1.20260914

### Patch Changes

- 3cd773f: Greedy and EdgeReg show all three viewer panels on phones. TopoFit conforms axis-aligned and oblique scans through the pinned npm niimath WebAssembly worker. SYNcro now matches the native three-input workflow, offers four checksum-pinned tutorials, defaults to MindGrab and Greedy with SynthStrip and ANTs alternatives, uses niimath for lesion and masking operations, and switches one NiiVue viewer between images with automatic lesion overlays. SynthSR lets adapter limits govern its largest activation buffer, so validated 256×256×192 scans and larger volumes on capable GPUs are attempted while other shared U-Net callers retain their existing limit. Add the standalone ANTS registration demo.

## 0.1.20260911

### Patch Changes

- Add native Greedy command-line help, retain upstream Greedy attribution in the CLI and npm package, and align the package and native Rust versions.

- dc50e56: Normalize NIfTI spatial units to millimetres and preserve scaled integer intensities when writing registered images. Isolate registration workers so cancelled input reads cannot affect a subsequent run.

  Use the shared download helper in both registration apps and expose Greedy command-line instructions through the application bar.

- Add nearest-neighbor reslice interpolation for discrete masks and label maps.

## 0.1.0

### Minor Changes

- Add the reusable Greedy Rust/WebAssembly registration package and the Greedy browser app with affine and deformable modes, brain-only defaults, and MindGrab extraction for custom images.

- Reject invalid NIfTI spatial geometry and verify the Rust workspace alongside the browser wrapper.
