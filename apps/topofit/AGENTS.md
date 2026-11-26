# topofit instructions

- `apps/topofit/src/stl-worker.js` imports `@niivue/niimath/niimath.js` (the package's raw Emscripten
  export) and calls `callMain` directly instead of the fluent `Niimath`/`.mesh()` API: that API's `run()`
  always appends `-odt <type>` as the final argv, but niimath mesh mode reads the *last* argv as the
  output filename, so the fluent API cannot select mz3 output. The pinned `@niivue/niimath@1.4.20260909`
  WASM build is also compiled without `HAVE_FORMATS`, so it can only write `.mz3`; `@neurodesk/webapp-components/file-io/mesh`
  round-trips mz3 and writes STL itself. Both are fixed upstream in `~/src/niimath` for the release after
  1.4.20260909 — once that ships, drop the direct `callMain` path and `writeMz3`/`readMz3` for the fluent
  API's own STL output.
- The `topofit` command (`packages/topofit/bin/topofit.js`, `src/node.js`) runs the same pipeline on the CPU
  with `onnxruntime-node`; `exes/node-cli` packages it (shared with SYNcro, driven by `release.json`), and
  every archive must pass `validation/cli-check.mjs`. Only presets in the pipeline's `MODELS` are accepted or
  installed; add `synth-1mm` there only together with its own parity report.

For shared FreeBrowse viewer rules (`topofit`, `spinalcordtoolbox`, `dicomview`), see [packages/runtime-support/AGENTS.md](../../packages/runtime-support/AGENTS.md).
