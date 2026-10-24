# @neurodesk/fastprep

Browser host for the fastprep Rust core (`exes/fastprep`) and glm (`exes/glm`), both built to WASM. The core
decides every step and emits tool argv, as written to `work/commands.sh`; this package owns the files (in memory,
`src/files.js`) and runs each step on its browser runtime (`src/drivers.js`): niimath (Emscripten), MindGrab,
Greedy (threaded WASM), SynthSR (ONNX Runtime Web), glm and sdc (PyHySCO WASM). The native CLI runs the same argv as processes.

`runFastprep` in `src/index.js` takes the BIDS dataset, MNI templates and runtimes, and returns all files
(derivatives under `/out`, `commands.sh` under `/work`). Steps run one at a time so peak memory is one tool's
working set. A 1 GB float32 limit (`MAX_BOLD_BYTES`, magnitude plus phase echoes) is checked from headers before processing.

## Drivers

- Each driver declares the options it handles and rejects anything else, so a core change that adds an option
  fails loudly instead of being ignored.
- niimath: `ENV` must be set in Emscripten `preRun`: libc copies it in its startup constructors, before
  `callMain`. The WASM build has no zstd, so `.nii.zst` intermediates are written as raw `.nii`
  and keep their `.zst` name for the core.
- An unmapped tool (e.g. `topofit`) exits 127; the browser runs with `surfaces` off, so the core never asks for it.

## Build and test

```bash
pnpm --filter @neurodesk/fastprep build:wasm   # wasm-pack; writes the gitignored ./wasm
pnpm --filter @neurodesk/fastprep test
node packages/fastprep/validation/node-demo.mjs BIDS_DIR TEMPLATES_DIR OUT_DIR TOOL_BIN_DIR [OMP]
```

`node-demo.mjs` runs this host under Node: core, niimath and glm as WASM, MindGrab on CPU via
`@neurodesk/node-drivers`; Greedy and SynthSR need a browser, so it calls native binaries behind the same API.

PEPOLAR calls accept an optional `runtimes.sdc` module or lazy loader returning
`loadSdc` from `@neurodesk/sdc`. The core supplies temporal means and explicit,
validated acquisition parameters. See `exes/fastprep/README.md` for supported grids,
Jacobian/sign conventions and the deliberate SuCor divergence.

The pinned SDC native-field comparison includes niimath temporal averaging:

```bash
node packages/fastprep/validation/sdc-reference.mjs "$TMPDIR/fastprep-sdc-reference"
```

The script verifies downloaded checksums and requires brain median error < 0.001 Hz.
