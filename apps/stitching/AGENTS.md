# stitching instructions

- The numerics are pure JavaScript in `apps/stitching/src/core` (layout, FFT, pairwise phase correlation, global optimisation, fusion), written from Preibisch et al. 2009. Fiji's Stitching and BigStitcher are GPL-2: external validation references only, never copy their code.
- `validation/fiji-example.mjs` compares the Node pipeline with Fiji's Grid/Collection stitching on the example and records `validation/example-reference.json`, including the SHA-256 of the registered TileConfiguration and fused TIFF that `e2e/smoke.spec.js` requires the browser to reproduce. Rerun it with `--write` after any change to the numerics, and rerun `validation/synthetic-real.mjs`; `test/reference.test.js` holds both to their limits (Fiji within 1 px, known offsets within 0.5 px).
- Offsets are tile B's position minus tile A's, x first; positions are the pixel coordinates of each tile's first pixel. Pair weights are r × overlapping pixels; README lists this and the other deliberate differences from Fiji.
- TIFF is read and written only through `@neurodesk/webapp-components/file-io/tiff`; OME stage positions come from its `stagePosition`.
