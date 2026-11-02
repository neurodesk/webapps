---
"sdc": minor
"@neurodesk/sdc": minor
---

Add a portable `sdc` command line for Linux, Windows and macOS. It runs the SyN-SDC pipeline of `@neurodesk/sdc/syn` (the sdcflows 2.17.1 fieldmap-less port) on one DWI series with a T1w of the same session: MindGrab brain masks through `@neurodesk/node-drivers/mindgrab` (or `--epi-mask` and `--t1w-mask`), the registration, DenoiseImage and N4 WebAssembly kernels in worker threads, the field fit and the unwarp, and writes the BIDS derivatives. The gradients and sidecar beside the series are found by name; `--pe-dir` and `--readout` override the sidecar. `download-models` fetches the pinned distortion prior and its notices, which the archives bundle; `--no-prior` uses the T1w mask in its place. Its release check runs the pipeline's synthetic subject with both MindGrab masks and holds every output to the files the same pipeline wrote in Chromium on the web app's browser runtimes (`validation/browser-reference.json`): each image by its decompressed bytes, the other files byte for byte. The sdc app is now released, so its archives have a release to attach to.
