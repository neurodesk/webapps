# @neurodesk/shoreline

The browser wrapper of [`exes/dwi/shoreline`](../../exes/dwi/shoreline/README.md), an eddy-like
correction of diffusion MRI: head motion, eddy-current fields, a susceptibility field and slice
outliers, estimated together, then one resampling. The `dwicorrect` app uses it.

`scripts/build-wasm.mjs` builds two modules of [`exes/dwi/shoreline-wasm`](../../exes/dwi/shoreline-wasm)
into `wasm/` (not committed): `wasm/threads`, with threads through wasm-bindgen-rayon for
cross-origin isolated pages, and `wasm/single` for any page. It needs the toolchain that the
greedy package uses: `nightly-2025-11-15` with `rust-src` and the `wasm32-unknown-unknown`
target, and wasm-pack 0.13.1.

```js
import { loadShoreline, runShoreline, threadCount } from "@neurodesk/shoreline";

const { api, threads } = await loadShoreline({ threadsUrl, singleUrl, threads: threadCount() });
const outputs = runShoreline({
  api,
  files: { "dwi.nii.gz": series, "mask.nii.gz": mask, acqp, index, bvals, bvecs },
  args: ["--imain=dwi.nii.gz", "--mask=mask.nii.gz", "--acqp=acqp", "--index=index",
    "--bvecs=bvecs", "--bvals=bvals", "--repol", "--out=out"],
  onLog: (line) => console.log(line),
});
// outputs["out.nii.gz"], outputs["out.parameters"], ...
```

The arguments are the native command line's (eddy's names), and the outputs are its files.
Run it in a worker: a run blocks its thread. `estimateMemory` and `fitsInMemory` tell whether a
series fits in WebAssembly's 4 GB.

## Tests

`pnpm test` checks the wrapper and runs the single-threaded module and the native binary on a
phantom that the crate exports (`export_command_line_phantom`); every output must agree within
1e-5 of its largest value, and the outlier map exactly. Locally, on 30 ADNI sessions and 4
OpenNeuro series (ds006676 multiband 1 and 6, ds004737 with and without slice-to-volume), the
largest differences were 4e-8 in the images, 5.5e-8 in the movement and 1.3e-5 in the z-score
maps (their last printed digit); the outlier maps were identical in all 34. It needs
cargo and `pnpm build:wasm` first.

| Series | Browser (Chromium 156) | Native |
| --- | --- | --- |
| ds006676 MB3, 112 × 112 × 72 × 141, topup field, 1 thread | 224 s | 214 s |
| the same, 8 threads | 42 s | 32 s |
