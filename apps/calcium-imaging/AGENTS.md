# calcium-imaging instructions

- The numerics are pure JavaScript in `apps/calcium-imaging/src/core` (registration, FFT, images, ROIs, traces, OASIS, pipeline), written from the papers. CaImAn (GPL-2), Suite2p and OASIS (GPL-3) are external validation references only: never copy their code. `validation/*.py` record their outputs into `test/fixtures` and `validation/caiman-rigid-shifts.json`; rerun them (README lists the environment) instead of loosening a tolerance.
- Shifts are `[dy, dx]` applied to a frame to register it. The default estimator is the plain Fourier cross-correlation because that is what NoRMCorre and CaImAn compute; with one template pass the example's shifts equal CaImAn's `register_translation` on every frame, and `e2e/smoke.spec.js` holds the browser to that and to the Node pipeline. Keep both.
- TIFF stacks are read and written only through `@neurodesk/webapp-components/file-io/tiff`; do not add an app-local TIFF reader or writer.
- The worker pool shares the movie through SharedArrayBuffer (the page is cross-origin isolated) and falls back to one worker with copies. Each task gets a fresh worker, terminated on cancel.
- ROI detection is deliberately simple (correlation-image seeds and watershed) and is not Suite2p's or CNMF's; About and the README say so. It leaves out the border band that resampling filled from the edge.
