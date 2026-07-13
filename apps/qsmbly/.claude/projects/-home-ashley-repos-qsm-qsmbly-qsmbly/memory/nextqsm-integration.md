# NeXtQSM Integration into QSMbly

## Decision: Implement in qsmbly (not QSM.rs)
- QSM.rs has no ONNX/ML support and can't get one (no WASM-compatible ONNX runtime in Rust)
- qsmbly already has a proven pattern from prostate/web (onnxruntime-web + localforage caching)
- QSM.rs already provides the FFT/dipole ops the VarNet loop needs

## Architecture
- NeXtQSM = BF removal + dipole inversion via deep learning
- Two networks: BF UNet (7 layers, ~109MB) + VarNet UNet (6 layers, ~41MB)
- VarNet runs inside a 6-step iterative optimization loop with learned lambdas
- Total weights ~150MB, hosted on OSF

## Key Technical Challenge: VarNet Gradient
The solver uses tf.GradientTape for auto-differentiation through the UNet.
The existing ONNX export only captures forward passes, not the iterative loop.

Three approaches (in preference order):
A) Export full solver as single ONNX (if tf2onnx can trace GradientTape)
B) Export "VarNet gradient step" ONNX + analytical E_D gradient in JS
C) Analytical E_D gradient + RED approximation (dE_R/dx ≈ x - VarNet(x))

## Pipeline Integration Point
After phase unwrap + B0 calculation, replaces BG removal + dipole inversion.
Input needs Hz→ppm conversion. Padding to multiple of 64 required.
Data layout: qsmbly=Fortran order, ONNX=C-contiguous (need transpose).

## Reference Implementation
prostate/web uses: onnxruntime-web@1.17.0, WASM backend, localforage caching,
Web Worker inference, model download with progress. Already uses QSM.rs WASM too.

## Key Files
- nextqsm solver: ~/repos/qsm/nextqsm/nextqsm/models/solver_all.py
- nextqsm ONNX export: ~/repos/qsm/nextqsm/convert_to_onnx.py
- nextqsm dipole kernel: ~/repos/qsm/nextqsm/nextqsm/processing/qsm.py
- prostate/web inference: ~/repos/prostate/web/js/inference-worker.js
- qsmbly worker: js/qsm-worker-pure.js
- qsmbly pipeline settings: js/controllers/PipelineSettingsController.js
