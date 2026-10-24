# @neurodesk/noddi

Diffusion tensor and NODDI fitting for the `noddi` web app and its command line.
The numerical code is the Rust workspace in [`exes/dwi`](../../exes/dwi), compiled to one WebAssembly module, `src/noddi.wasm`.
The design is in [the diffusion microstructure design](../../docs/architecture/dwi-microstructure-design.md).

## Use

```js
import { loadNoddi } from '@neurodesk/noddi';

const noddi = await loadNoddi(fetch(new URL('@neurodesk/noddi/wasm', import.meta.url)));
const table = noddi.describe(bvals, bvecs);
// table.shells, table.dtiVolumes, table.noddiError (null when NODDI can run)
const maps = noddi.dtiFit(data, voxels, bvals, bvecs, { mask });
// maps.FA, maps.MD, maps.AD, maps.RD, maps.S0, maps.V1x, maps.V1y, maps.V1z
```

```js
const model = noddi.noddiModel(bvals, bvecs); // throws when NODDI cannot run
const out = model.fit(chunk, chunkVoxels, chunkMask);
// out.ICVF, out.ISOVF, out.OD, out.dirx, out.diry, out.dirz
model.free();
```

`data` is a Float32Array with the volumes one after the other, as `readNiftiFrames` returns them.
`model.fit` takes the same layout for a chunk of voxels, so a caller can report progress or spread chunks over workers.
AMICO 1.5.4 remains the default; [exes/dwi/amico](../../exes/dwi/amico/README.md) describes its reference parity. Select the optional nonlinear Watson fit with `noddiModel(bvals, bvecs, { method: 'dmipy' })`. It ports dmipy at `2d6073218eb4ebc97645ac6e275270c36834e33d`; [exes/dwi/dmipy](../../exes/dwi/dmipy/README.md) documents the model, source and independent reference gates. After a nonlinear chunk, `model.diagnostics` reports fitted, skipped and nonconverged voxel counts. Nonpositive first measurements are skipped, as in dmipy; numerical failures reject the chunk.
`bvecs` is three rows (x, y, z) with one value per volume, as in an FSL `.bvec` file.

## Shared code

The web app and the command line run one fit from this package:

| Module | Content |
| --- | --- |
| `src/pipeline.js` | Mean b0, mask indices, BIDS output names and maps |
| `src/fit-pool.js` | Selects the tensor backend and spreads masked voxels over fitting workers |
| `src/dtifit.js` | Shared niimath inputs, selected volumes and output conversion |
| `src/fit-worker.js` | The worker handler: tensor and the selected NODDI method on one chunk |
| `src/node.js`, `src/node-worker.js` | The command line: files, MindGrab on the CPU, `worker_threads` |

The app's Web Workers and the command line's worker threads take the same chunks through the same `noddi.wasm`, so the maps do not depend on the runtime or the number of workers.

## Command line

`noddi` runs the web app's fit: a MindGrab brain mask of the mean b0, the tensor fit and, with two or more shells, NODDI (AMICO).
It needs no browser, GPU or network.

### Install

Download the release for your platform from the NODDI app's Standalone dialog: Linux x64, Windows x64 or macOS on Apple silicon.
Each contains a private Node.js runtime.

```bash
tar -xzf noddi-VERSION-linux-x64.tar.gz
./noddi-VERSION-linux-x64/noddi self-check
```

On Windows, use `Expand-Archive` and `noddi.exe`.
On macOS, `sudo installer -pkg noddi-VERSION-macos-arm64.pkg -target /` installs `/usr/local/bin/noddi`.

### Commands

```bash
noddi dwi.nii.gz dwi.bval dwi.bvec results
noddi dwi.nii.gz dwi.bval dwi.bvec results --mask brain_mask.nii.gz
noddi dwi.nii.gz dwi.bval dwi.bvec results --no-mask --threads 8
noddi dwi.nii.gz dwi.bval dwi.bvec results --no-noddi --tensor-fit ols
noddi dwi.nii.gz dwi.bval dwi.bvec results --tensor-fit niimath-dtifit
noddi dwi.nii.gz dwi.bval dwi.bvec results --method dmipy
noddi self-check
```

`--method dmipy` selects the nonlinear fit; omitting it keeps AMICO. The final provenance JSON records the method, pinned dmipy source and aggregate optimizer diagnostics. The same method and diagnostics travel through the app's shared fitting pool.

The actual WASM fits all 13,324 eligible voxels of the maintainer's pinned FA ≥ 0.4 WM mask against the independent dmipy reference. Maximum ICVF, ISOVF and ODI differences are 0.001775, 0.001627 and 0.002245, each below 0.02. Four WASM fits stop without optimizer convergence; their returned maps remain in the comparison. This WM gate does not erase the separate whole-brain optimizer tails documented in the Rust port's report.

By default the brain mask is MindGrab's of the mean b0, as in the web app.
The command line runs MindGrab's CPU modules through `@neurodesk/node-drivers/mindgrab` (about 2.6 GB of memory); do not run two at once.
`--mask FILE` uses your own mask, on the diffusion image's voxel grid; `--no-mask` fits every voxel.
`--threads N` sets the worker threads (default: one per core).
The files go to standard output and the settings that produced them, as one JSON line, to standard error. With `--tensor-fit niimath-dtifit`, `niimath` in that line names the niimath build.
`OUTPUT_DIR` must be new or empty.

### Release check

`apps/noddi/e2e/reference.spec.js` fits the app's pinned example and the two-shell phantom (`src/phantom.js`) in the built web app and records every download in `validation/browser-reference.json` (`NODDI_BROWSER_REFERENCE=write`; `check` compares).
The example gets the command line's CPU MindGrab mask through the app's mask input, so the comparison isolates the fit.
`validation/cli-check.mjs` runs a command line, or an extracted archive with `--executable`, on the same cases and requires each file to equal the web app's once decompressed.
Rerecord the reference after changing `exes/dwi`, the pipeline or MindGrab.
The example is the app's first: the ds005134 sub-01 multi-shell slab, which covers the MindGrab mask, the tensor fit and NODDI on real data; the phantom covers `--no-mask` and the OLS tensor.
The app's second example, dwi2trx's single-shell DWI, covers the NODDI refusal in the browser tests.

### Citation

Zhang H, Schneider T, Wheeler-Kingshott CA, Alexander DC. NODDI: practical in vivo neurite orientation dispersion and density imaging of the human brain. NeuroImage. 2012;61(4):1000-1016.

Daducci A, Canales-Rodriguez EJ, Zhang H, Dyrby TB, Alexander DC, Thiran JP. Accelerated Microstructure Imaging via Convex Optimization (AMICO) from diffusion MRI data. NeuroImage. 2015;105:32-44.

## Rules

- A volume with b < 50 s/mm² is a b0.
- Shells are the non-zero b-values rounded to the nearest 100 s/mm².
- The tensor fit uses the b0 volumes and every shell up to b = 1200 s/mm²; data with no shell that low uses its lowest shell.
- NODDI needs two or more shells.

## Tensor fit

`--tensor-fit` selects `wls` (the default), `ols` or `niimath-dtifit`, as in the browser.
The niimath option runs DWI2TRX's corrected vendored dtifit build; the package injects a fresh Node module through `@neurodesk/dwi2trx/node-runner`, while the browser uses a cancellable worker.
Both hosts use the same tensor volumes and map conversion. NODDI runs afterward when selected.

The weighted fit uses the squared observed signal as weights, as FSL `dtifit -w` does.
On the dwi2trx example, the FA and MD maps equal FSL 6.0.7.23 `dtifit -w` in the median voxel (FA difference 1.5e-8).
Voxels with a non-positive sample, and CSF voxels at the noise floor, differ: FSL treats those samples in a way that is not documented.
A non-positive sample takes the smallest positive sample of its voxel.

## Build

The module is committed. After a change to `exes/dwi`, run:

```bash
pnpm --filter @neurodesk/noddi build:wasm
pnpm --filter @neurodesk/noddi check:wasm
```

The build needs Rust 1.98.0 with the `wasm32-unknown-unknown` target and binaryen `version_117` `wasm-opt`.
`check:wasm` fails when a rebuild does not give the committed bytes.
