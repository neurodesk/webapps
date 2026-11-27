# InstanSeg app notes

- Engine, image I/O, and model manifest live in `packages/instanseg` and `models/instanseg.manifest.json`.
- Scope is bounded 2D RGB `brightfield_nuclei` (`instanseg_models_v0.1.1`, Apache-2.0, up to 16 MP / 4096 × 4096) in the `microscopy` catalogue; whole-slide images and multiplex fluorescence are handled by the Neurodesk `instanseg` 0.1.2 container listed under Standalone.
- The 2D `InstanSeg_UNet` backbone (`m.fcn`, 7 float32 opset-17 ops) runs in ONNX Runtime Web (`ort-web-asyncify`); the 61-parameter `ProbabilityNet` pixel classifier, 8-connected fragment cleanup/hole filling, sparse IoMA merging (`> 0.3`), and overlap-tile stitching run in pure JS (`packages/instanseg/src/pipeline.js`).
- Keep `app_scoped_runtime_families: [ort-web-asyncify]` and `isolationFallback()` so threaded WASM and WebGPU work in both isolated and fallback contexts.
