# Easy MP2RAGE T1 Map — in-browser app

A static single-page app that runs the MP2RAGE/SA2RAGE T1-mapping pipeline
**entirely in your browser** via the Rust core compiled to WebAssembly. Drag in
NIfTI files, assign roles, compute, preview, and download. **Your images are
never uploaded** and there is no processing backend. (The shared Neurodesk
hosting shell reports page views only, respects Do Not Track and Global Privacy
Control, and never sends images, results, or custom events. The app source itself
contains no analytics bootstrap.)

## Stage the WASM core, then run

```bash
# 1. stage the committed wasm core from packages/easy-mp2rage into web/vendor/easy-mp2rage/
tools/stage_core.sh

# 2. serve the web/ folder over http (ES modules + wasm need http, not file://)
cd web
python3 -m http.server 8000
# open http://localhost:8000
```

Then drag in **UNI**, **INV2**, and either a **SA2RAGE** (2-volume) or a
**B1 map**. Roles are guessed from filenames and editable. Set the sequence
parameters (7T/3T presets provided; dcm2niix `.json` sidecars auto-fill TI/FA/TR),
click **Compute T1 map**, preview the result, and download the outputs
(`T1map.nii.gz`, `B1map.nii.gz`, uncorrected T1, corrected UNI, `parameters.json`).

## Pieces

| file | role |
|------|------|
| `index.html` | layout + styles |
| `js/app.js` | drag-drop, role assignment, params, orchestration, canvas viewer, downloads |
| `vendor/easy-mp2rage/src/nifti.js` | NIfTI-1 read/write in JS, staged from `packages/easy-mp2rage` (mirrors the Rust I/O; validated against golden) |
| `js/worker.js` | Web Worker that runs the WASM core off the UI thread |
| `vendor/easy-mp2rage/wasm/` | the WASM core committed in `packages/easy-mp2rage/wasm/` (staged by `tools/stage_core.sh`; gitignored here) |
| `test/e2e_node.mjs` | headless check: nifti.js → WASM → nifti.js reproduces the Python golden |

## Validate headlessly

```bash
node web/test/e2e_node.mjs   # after tools/stage_core.sh
```

## Notes

- The viewer is a self-contained canvas slice montage (no external/CDN
  dependency, CSP-safe). NiiVue can be added later for 3D/multiplanar.
- Compute is single-threaded WASM + SIMD (GitHub Pages can't set the COOP/COEP
  headers threads need). Typical ~1 mm volumes run comfortably; the very largest
  (0.75 mm, ~25M voxels) are memory-heavy (see the core's f32 memory note).
- Research software, no warranty. Sanity-check the maps and confirm parameters.
