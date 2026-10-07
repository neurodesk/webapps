---
"brain-extraction": minor
"@neurodesk/brain-extraction": minor
"@neurodesk/synthstrip": patch
---

Add the `brain-extraction` command line: SynthStrip on ONNX Runtime Node and BET on a single-threaded WebAssembly build of the same qsm-core BET the web app runs, writing the web app's brain image and mask under the same names. It takes `--method synthstrip|bet` and BET's `--fractional-intensity`; `--method mindgrab` explains that MindGrab follows with #162. The SynthStrip model is installed with SHA-256 checks on every load, and the command line ships as portable Linux x64 and Windows x64 archives and a signed macOS arm64 installer that each bundle Node and the model. Each release must reproduce the web app's results on the pinned T1 example, as recorded in a browser: identical NIfTI headers, brain intensities and mask voxel counts, a BET mask identical bit for bit, and a SynthStrip mask Dice of 0.9999 or better. The web app now takes its download names and NIfTI writer from `@neurodesk/brain-extraction`, and its SynthStrip model pin from `@neurodesk/synthstrip/model`.
