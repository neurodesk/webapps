---
"white-matter-lesions": minor
"@neurodesk/white-matter-lesions": minor
---

Add the `flames` command line: FLAMeS lesion segmentation on the CPU with ONNX Runtime Node, writing the web app's lesion mask, probability map and lesion table under the same names. It takes the app's `--folds 1|5` and `--skull-stripped` settings, installs SynthStrip and all five folds with SHA-256 checks on every load, and ships as portable Linux x64 and Windows x64 archives and a signed macOS arm64 installer that each bundle Node and the models. Each release must match the web app's WebAssembly pipeline on the pinned example at mask Dice 0.998 or better. The pipeline moves into the new `@neurodesk/white-matter-lesions` package, which the web app now uses.
