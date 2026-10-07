# @neurodesk/white-matter-lesions

## 0.2.20261007

### Minor Changes

- 5ec8fe3: Add the `flames` command line: FLAMeS lesion segmentation on the CPU with ONNX Runtime Node, writing the web app's lesion mask, probability map and lesion table under the same names. It takes the app's `--folds 1|5` and `--skull-stripped` settings, installs SynthStrip and all five folds with SHA-256 checks on every load, and ships as portable Linux x64 and Windows x64 archives and a signed macOS arm64 installer that each bundle Node and the models. Each release must reproduce the web app's lesion count, mask volume and summed probability, as recorded in a browser, on the pinned example with one fold and with the ensemble. With one fold it must also match the web app's WebAssembly pipeline at mask Dice 0.998 or better, with no probability more than 0.1 apart. The pipeline moves into the new `@neurodesk/white-matter-lesions` package, which the web app now uses.

### Patch Changes

- @neurodesk/synthsr@0.6.20261007
- @neurodesk/synthstrip@0.1.2
- @neurodesk/synthsr@0.6.20261007
