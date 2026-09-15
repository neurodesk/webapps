# Brain extraction

Choose a T1- or T2-weighted full-head scan from **Example**, or load one NIfTI
image or DICOM series. Choose MindGrab, BET or SynthStrip, and
select **Extract brain**. View and download the brain image and binary mask.
Processing stays in the browser. Cancel stops the worker and active downloads.
Examples load into the viewer without starting extraction. Their pinned Hugging
Face URLs are listed in `examples.json` and included in the offline asset catalog.

MindGrab defaults to its available GPU backend. SynthStrip uses ONNX Runtime
Web on the CPU and downloads a checksum-verified model. BET uses QSMbly's Rust
WebAssembly runtime and needs no model. Its fractional intensity setting
accepts 0 to 1; lower values produce larger masks.

MindGrab's advanced settings also offer CPU processing for machines where
automatic graphics selection is slow. CPU processing requires cross-origin
isolation, which the app's hosting configuration supplies.

```sh
pnpm --filter brain-extraction dev
pnpm --filter brain-extraction build
pnpm --filter @neurodesk/brain-extraction test
pnpm --filter brain-extraction test:e2e
BRAIN_EXTRACTION_REAL_MODELS=1 pnpm --filter brain-extraction test:e2e
```

The Vite asset plugin serves the same MindGrab and BET runtimes in development
and production. A clean checkout builds missing BET artifacts with QSMbly's
`build.sh`, which requires Rust, its `wasm32-unknown-unknown` target and
`wasm-pack`. The catalog build schedules this app after QSMbly to avoid
concurrent writes to the same runtime.

The shared `@neurodesk/brain-extraction` package owns the BET adapter and
MindGrab adapter used by SYNcro. SynthStrip uses the existing
`@neurodesk/synthstrip` pipeline unchanged. Citations live in
`registry/app-information.yml`.

The browser tests compare BET's mask byte for byte with QSMbly's Rust output,
check DICOM import, cancellation and settings persistence, and verify NIfTI
geometry. The optional model tests run MindGrab on the CPU and SynthStrip on
the existing anatomical template fixture. They check pipeline behavior rather
than clinical extraction accuracy across scan types.
