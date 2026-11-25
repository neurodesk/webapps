# fastprep instructions

- The Rust core (`exes/fastprep/core`) decides every step and emits tool argv, as written to `work/commands.sh`. The native CLI (`exes/fastprep/cli`) runs it as processes; the browser host (`packages/fastprep/src/drivers.js`) maps it to WASM/WebGPU runtimes and rejects options it does not declare. A core change that adds a tool option needs a driver change, or the browser run fails.
- Byte parity with the Python reference (`fastprep.py`, `glm.py`) is the goal. Deliberate divergences are listed in `exes/fastprep/README.md` and `exes/glm/README.md`; add any new one there.
- niimath WASM reads `ENV` during startup, so set it in Emscripten `preRun`. It has no zstd: `.nii.zst` names are staged as raw `.nii`.
- `vite.config.js` excludes `@brainchop/core` and `onnxruntime-web` from `optimizeDeps`: MindGrab's top-level await breaks esbuild's es2020 dev pre-bundle, and `dev` fails without it. Any app importing either needs the same.
- The full-example e2e test is `@slow` and needs `NEURODESK_HARDWARE_GPU=1`; the headless shell has no WebGPU and takes hours.
- ME-ICA runs after the apply stage for runs with ≥3 magnitude echoes (`--meica auto|on|off`, default `auto`): the core emits `meica` and `meica --denoise` argv, writing `space-*_desc-denoised_bold` beside each preproc. The Rust core must match `fastprep.py`'s commands and ME-ICA outputs.
- `meica` is `@niivue/meica`, pinned exactly in `packages/fastprep` and `apps/fastprep` (single-threaded WASM, staged into `public/meica` by `scripts/copy-runtime.mjs`, driven by `meicaDriver`); the native CLI runs the meica-rs binary from `<home>/bin`.
- When head motion is locked to the task, tedana's default tree can reject task signal (motor3T: task>baseline |t|>5 voxels 4565 → 86). The report warns; denoised is a separate output, never a replacement. Full results: `~/src/fastprep/plan_meica.md`.
- The multi-echo example `motor3t-me` (HF `fastprep/example-me`, staged by `stage_me_example.py` in fastprep.py's repository) has its own `@slow` hardware-GPU e2e test.
