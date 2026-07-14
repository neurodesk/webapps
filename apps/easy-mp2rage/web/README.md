# Easy MP2RAGE T1 Map — in-browser app

A static single-page app that runs the MP2RAGE/SA2RAGE T1-mapping pipeline
**entirely in your browser** via the Rust core compiled to WebAssembly. Drag in
NIfTI files, assign roles, compute, preview, and download. **Your images are
never uploaded** and there is no processing backend. (The hosted page loads
Google Analytics 4, which reports anonymous page views only — never your images
or results. Delete the GA `<script>` in `index.html` to self-host without it.)

## Build the WASM, then run

```bash
# 1. build the wasm core and stage it into web/wasm/  (needs wasm-pack)
tools/build_wasm.sh

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
| `js/nifti.js` | NIfTI-1 read/write in JS (mirrors the Rust I/O; validated against golden) |
| `js/worker.js` | Web Worker that runs the WASM core off the UI thread |
| `wasm/` | `wasm-pack` output (built by `tools/build_wasm.sh`; gitignored) |
| `test/e2e_node.mjs` | headless check: nifti.js → WASM → nifti.js reproduces the Python golden |

## Validate headlessly

```bash
node web/test/e2e_node.mjs   # after tools/build_wasm.sh
```

## Notes

- The viewer is a self-contained canvas slice montage (no external/CDN
  dependency, CSP-safe). NiiVue can be added later for 3D/multiplanar.
- Compute is single-threaded WASM + SIMD (GitHub Pages can't set the COOP/COEP
  headers threads need). Typical ~1 mm volumes run comfortably; the very largest
  (0.75 mm, ~25M voxels) are memory-heavy (see the core's f32 memory note).
- Research software, no warranty. Sanity-check the maps and confirm parameters.
