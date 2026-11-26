# histo2mri instructions

- The pipeline (`apps/histo2mri/src/core`) is pure JavaScript with Greedy injected (`greedy.rigid`, `.affine`, `.svf`); the worker runs it on `@neurodesk/greedy/wasm-single`, the Node tests and `validation/run.mjs` on `@neurodesk/greedy/single`, the same committed bytes.
- Greedy is 3D, so sections are registered in the plane's local frame: the moving image is a three-slice slab 1 m apart and linear results keep only in-plane terms. The deformable stage needs a three-slice fixed image masked on the middle slice and full-resolution iterations only: on a one-slice fixed image Greedy's across-plane NMI gradient dominates its normalised update and the warp stays near zero. Keep that if the Greedy call changes.
- NMI scores for choosing an orientation or keeping a plane use the whole plane with the section's outside as background; overlap-only NMI picked placements far off the tissue.
- `validation/results.json` holds the synthetic and example landmark errors; rerun `node validation/run.mjs` after changing the pipeline or Greedy and update the numbers in the README and About.
