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
NODDI is a port of AMICO 1.5.4; [exes/dwi/amico](../../exes/dwi/amico/README.md) describes it and its parity with AMICO.
`bvecs` is three rows (x, y, z) with one value per volume, as in an FSL `.bvec` file.

## Shared code

The web app and the command line run one fit from this package:

| Module | Content |
| --- | --- |
| `src/pipeline.js` | Mean b0, mask indices, BIDS output names and maps |
| `src/fit-pool.js` | Splits the masked voxels into 2048-voxel chunks and spreads them over workers |
| `src/fit-worker.js` | The worker handler: tensor and AMICO on one chunk |
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
noddi self-check
```

By default the brain mask is MindGrab's of the mean b0, as in the web app.
The command line runs MindGrab's CPU modules through `@neurodesk/node-drivers/mindgrab` (about 2.6 GB of memory); do not run two at once.
`--mask FILE` uses your own mask, on the diffusion image's voxel grid; `--no-mask` fits every voxel.
`--threads N` sets the worker threads (default: one per core).
The files go to standard output and the settings that produced them, as one JSON line, to standard error.
`OUTPUT_DIR` must be new or empty.

### Release check

`apps/noddi/e2e/reference.spec.js` fits the app's pinned example and the two-shell phantom (`src/phantom.js`) in the built web app and records every download in `validation/browser-reference.json` (`NODDI_BROWSER_REFERENCE=write`; `check` compares).
The example gets the command line's CPU MindGrab mask through the app's mask input, so the comparison isolates the fit.
`validation/cli-check.mjs` runs a command line, or an extracted archive with `--executable`, on the same cases and requires each file to equal the web app's once decompressed.
Rerecord the reference after changing `exes/dwi`, the pipeline or MindGrab.
The example is dwi2trx's single-shell DWI, which covers the tensor fit, the NODDI refusal and the MindGrab mask; the phantom covers NODDI.
Move the check to the ds005134 slab when it becomes the app's example (#421).

### Citation

Zhang H, Schneider T, Wheeler-Kingshott CA, Alexander DC. NODDI: practical in vivo neurite orientation dispersion and density imaging of the human brain. NeuroImage. 2012;61(4):1000-1016.

Daducci A, Canales-Rodriguez EJ, Zhang H, Dyrby TB, Alexander DC, Thiran JP. Accelerated Microstructure Imaging via Convex Optimization (AMICO) from diffusion MRI data. NeuroImage. 2015;105:32-44.

## Rules

- A volume with b < 50 s/mm² is a b0.
- Shells are the non-zero b-values rounded to the nearest 100 s/mm².
- The tensor fit uses the b0 volumes and every shell up to b = 1200 s/mm²; data with no shell that low uses its lowest shell.
- NODDI needs two or more shells.

## Tensor fit

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
