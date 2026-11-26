# Runtime support instructions

## FreeBrowse viewer (topofit, spinalcordtoolbox, dicomview)

- `packages/runtime-support` pins `freebrowse` to the vendored `file:./vendor/freebrowse` build of FreeBrowse's development branch, which is not on npm. Rebuild it only with `node packages/runtime-support/scripts/vendor-freebrowse.mjs` (the vendor README names the commit). Return to a registry pin once upstream publishes that code.
- The branch builds against an unreleased niivue-mono checkout; the vendored build was made against `@niivue/niivue` `1.0.0-rc.17`, the first release with the drawing undo snapshot its wand calls, and runs on the `1.0.0-rc.26` that `packages/runtime-support` pins (rc.25 fixed `loadDrawing` on permuted images, which SCT's mask editing needs). Every app that mounts the viewer pins that same NiiVue. FreeBrowse's eye button sets a volume's `visible` flag (niivue/mono#224), which NiiVue draws from rc.24. A volume is shown only when `visible` is not false and its opacity is above 0: code that reacts to `volumeUpdated` checks both, and code that shows a volume itself also sets `visible: true` (SCT's `SctViewer`, TopoFit's 3D anatomy clip).

## dcm2niix

- Every app converts with the one `@niivue/dcm2niix` version pinned exactly in `packages/runtime-support` (also `packages/lcmodel`, `packages/mri2vid`, `apps/dicompare`; bump them together). Bundled apps import `@neurodesk/runtime-support/dcm2niix-client` (`readImageFiles`, `readImageSeries`, `readDiffusionSeries`, `runDcm2niix`); bundler-less apps use the shared `DicomController`/`createDicomConverter` on `dcm2niix/index.jpeg.js`, which `scripts/vendor-runtime-support.mjs` stages from npm in each such app's `prebuild` (`test/shared-imaging-refactor.test.mjs` enforces it). Never commit a dcm2niix build or write app-local conversion glue.
- Every path passes `-f %p_%t_%s`: dcm2niix 1.4's default name starts with the input folder, which can name a patient, and downloads derive from output names. Upstream has no default deadline; the shared paths set 120 s.
- The `read*` functions keep partial output (some series failed) and throw only when no image is produced; `runDcm2niix` rejects any exit code but 0 or 3.
- The 1.4 glue is browser-only: Node passes the sibling `.wasm` as `wasmBinary` (`@neurodesk/node-drivers/dcm2niix` takes the glue URL and does this).
- The composite site shares one `dcm2niix-jpeg` WASM family (`runtime-assets/manifest.json`); each app keeps its worker and glue in its own service-worker scope. A version bump changes its sha256 there.
- dwi2trx keeps its own drop walker (`src/dwi2trx/files.ts`) because it stops at 20 000 files during the walk; upstream's walker has no limit.
