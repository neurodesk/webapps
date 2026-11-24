---
"@neurodesk/runtime-support": minor
"@neurodesk/node-drivers": minor
"@neurodesk/brain-extraction": minor
"@neurodesk/brain2print": minor
"@neurodesk/browserqc": minor
"@neurodesk/deface": minor
"@neurodesk/dwi2trx": minor
"@neurodesk/fastprep": minor
"@neurodesk/hmc": minor
"@neurodesk/lcmodel": minor
"@neurodesk/n4": minor
"@neurodesk/noddi": minor
"@neurodesk/sdc": minor
"@neurodesk/syncro": minor
"ants": minor
"brain-extraction": minor
"brain2print": minor
"browserqc": minor
"deface": minor
"dwi2trx": minor
"dwicorrect": minor
"fastprep": minor
"fireants": minor
"greedy": minor
"hmc": minor
"lcmodel": minor
"n4": minor
"noddi": minor
"sdc": minor
"syncro": minor
---

Migrate every MindGrab/MindMap/MindSnap app, package and Node driver from the preview `@brainchop/mindgrab` releases (`0.1.20260813`, `0.1.20260925`, `0.1.20261008`) to `@brainchop/core@1.0.0`.

- Replaces `-gpu.wasm` binaries with `@brainchop/core`'s pure-JS WebGPU V4 runtime (`models/*.bin`, optional `shader-f16` with `f32` fallback, automatic `LowMem128` + paced Z-chunking), alongside updated WebGL2 (`glGetError` / `isContextLost()` checks) and threaded CPU WASM fallbacks.
- Picks up explicit `inference-failed` errors on empty masks or degenerate segmentations, MindMap-18 v4.0 Gold, MindSnap-104 v4.0 Gold, MindMap-Fast v3.5 (`16chan18cls` alias), and coil-flare-safe conform (`f_high = 0.98`).
- Unifies all shared MindGrab WASM binaries under `_runtime/mindgrab/1.0.0/` (`mindgrab-wasm-1-0-0`), strips duplicate bundled MindGrab weights/WASM from `ants`, `fireants`, `greedy`, `brain2print`, and `fastprep`, updates `brainchop-mindgrab` CLI options (`-v`/`--version`, `--no-turbo`), updates package/repository links to `neuroneural/brainchop-core`, and re-records all Chromium CPU validation baselines (MindGrab FreeSurfer SynthSeg Dice 0.9799).
