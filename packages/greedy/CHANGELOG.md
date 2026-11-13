# @neurodesk/greedy

## 0.9.20261113

## 0.9.20261111

### Minor Changes

- 3beb743: Add Histology to MRI, a browser app that registers 2D histology sections (RGB or greyscale TIFF, PNG or JPEG) to an MRI volume. The user gives the slice axis and an approximate slice; the app samples the MRI on that plane, chooses the section's orientation, registers it rigidly and affinely with Greedy's NMI metric, optionally searches the plane's offset and tilt, and finishes with a Greedy stationary-velocity warp, all in one worker per run. It downloads the section warped onto the MRI plane (RGBA NIfTI), the sections drawn into the MRI grid, and Greedy-compatible affine and warp files in world coordinates, and overlays the result on the MRI with adjustable opacity. On a synthetic test (an MRI slice deformed by a known affine and smooth warp and re-coloured as H&E) the mean landmark error falls from 7.5 mm (12.5 voxels of 0.6 mm) to 0.21 mm (0.35 voxels); on the AHEAD example it falls from 6.8 mm (11.3 voxels) to 1.8 mm (3.0 voxels) at six manual landmarks, where the plane search and warp did not reduce it (the affine alone gives 1.7 mm).

  `@neurodesk/webapp-components/file-io/tiff` gains `readTiffImage`, which reads one greyscale or colour image (RGB with alpha dropped, white-is-zero inverted, palette, YCbCr, CMYK and CIELab converted to RGB) and refuses stacks, channel stacks and over-budget images before decoding. The new `@neurodesk/webapp-components/file-io/raster-image` reads PNG and JPEG sizes from their headers (walking JPEG segments) and decodes them to RGBA without EXIF rotation.

  `@neurodesk/greedy`'s `registerAffineGreedy` and `registerRigidGreedy` take an optional `initial` matrix, and the package exports its single-threaded build as `@neurodesk/greedy/wasm-single` for bundled workers.

### Patch Changes

- a2675b9: Add Light-sheet atlas, a microscopy app that registers a cleared mouse brain to the Allen Mouse Brain CCFv3 (50 µm, from the BrainGlobe Atlas API) with Greedy and counts cell candidates per brain region, following BrainGlobe's brainreg and cellfinder. It reads TIFF stacks and OME-Zarr images plane by plane, detects candidates with a port of cellfinder's classical detection (identical to cellfinder 1.10.1 on its test crop: every thresholded plane and all 38 candidates), and writes the registered atlas labels, the candidate list and a per-region table of candidate counts, volumes and densities. Counts are of unclassified candidates. The Allen atlas is for research and noncommercial use only. On BrainGlobe's test brain its labels agree with brainreg's with a whole-brain Dice of 0.97.

  `@neurodesk/webapp-components` gains `file-io/microscopy-stack`, plane-by-plane readers for TIFF stacks (multi-page or one file per plane, with OME-XML and ImageJ voxel sizes read by the shared `file-io/tiff` parsers; a single OME-TIFF's z planes are the pages its TiffData maps, and a mapping the reader cannot follow, such as planes in another file, is refused before any pixel is decoded; OME-TIFF folders and files with several image series are refused) and OME-Zarr folders. `micrometresPerUnit` also reads the NGFF spellings meter and centimeter. `@neurodesk/greedy` exports its single-threaded WebAssembly glue as `@neurodesk/greedy/wasm-single` for bundlers.

## 0.8.20261109

## 0.8.20261108

## 0.8.20261104

## 0.8.20261103

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
