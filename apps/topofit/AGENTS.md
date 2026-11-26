# topofit instructions

- The `topofit` command (`packages/topofit/bin/topofit.js`, `src/node.js`) runs the same pipeline on the CPU
  with `onnxruntime-node`; `exes/node-cli` packages it (shared with SYNcro, driven by `release.json`), and
  every archive must pass `validation/cli-check.mjs`. Only presets in the pipeline's `MODELS` are accepted or
  installed; add `synth-1mm` there only together with its own parity report.

For shared FreeBrowse viewer rules (`topofit`, `spinalcordtoolbox`, `dicomview`), see [packages/runtime-support/AGENTS.md](../../packages/runtime-support/AGENTS.md).
