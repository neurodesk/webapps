# fastprep

fMRIPrep-style preprocessing of one BIDS subject (T1w and BOLD with JSON sidecars, events optional), entirely in
the browser. Images are not uploaded. The Rust core (`exes/fastprep`, WASM) plans each step and
`@neurodesk/fastprep` runs it on niimath, MindGrab, Greedy, SynthSR and glm in a worker. Output is the
derivatives tree, confounds, the HTML report (shown in the viewer) and, with events, left/right task t maps, as
one zip.

## Run and build

From the monorepo root:

```sh
pnpm install
pnpm --filter fastprep dev                                    # needs Rust (rustup) and wasm-pack
pnpm --filter fastprep build && pnpm --filter fastprep preview
pnpm --filter fastprep test
NEURODESK_HARDWARE_GPU=1 pnpm --filter fastprep test:e2e      # on a Mac with a GPU
```

`dev` and `build` first build Greedy's and fastprep's WASM (`runtime` script; Greedy pins its own nightly
toolchain) and stage them, with niimath, into the gitignored `public/`.

Use a Chrome-family browser with WebGPU. The motor3t example takes about 1.5–2 min on Apple silicon. Without a
hardware GPU, MindGrab and SynthSR fall back to slow paths: the `@slow` full-example e2e test skips unless
`NEURODESK_HARDWARE_GPU=1`, since Playwright's headless shell has no WebGPU and takes hours.

## Limits

- BOLD ≤ 1 GB decoded float32 per run, magnitude plus phase echoes; larger runs are rejected before processing.
- Steps run one at a time to bound peak memory to one tool's working set.
- No TopoFit surfaces.
- One subject per session; only the first `sub-*` is processed.

## Assets

The SynthSR model and MNI templates come from pinned Hugging Face revisions (`models/synthsr.manifest.json`,
`models/fastprep.manifest.json`), are checked by size and SHA-256, and are kept in the Cache API
(`neurodesk-fastprep-v1`) for later sessions. Example data is pinned in `examples.json`.

## Agent automation

`automation.json` declares one operation, `preprocess`: input `dataset` (the BIDS files, each named by its path
relative to the dataset root), output one derivatives zip. See
[desktop automation](../../packages/desktop/AUTOMATION.md).
