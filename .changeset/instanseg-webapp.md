---
"instanseg": minor
"@neurodesk/instanseg": minor
---

Add the InstanSeg brightfield nuclei instance segmentation webapp (`instanseg` v0.1.2, `brightfield_nuclei` v0.1.1) in the `microscopy` catalogue backed by `@neurodesk/instanseg` over ONNX Runtime Web (WebGPU with automatic threaded WASM CPU fallback), supporting bounded 2D RGB TIFF/OME-TIFF/PNG images, automatic `0.5 µm/px` calibration resampling, overlap-tile seam stitching, calibrated 16/32-bit label TIFF export, per-nucleus morphometry CSV, and WebMCP automation.
