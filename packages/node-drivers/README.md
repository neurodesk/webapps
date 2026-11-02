# @neurodesk/node-drivers

Node drivers that let a portable command line run the same WebAssembly as
its app, with no production dependencies. The caller supplies its pinned builds.

## Node drivers for command lines

The drivers take the build the caller pins, so a command line runs the bytes
its web app runs. Add MindGrab or niimath to the command line's own dependencies at the
app's version, alongside `@neurodesk/node-drivers`.

### niimath

`runNiimath` runs one niimath argv over in-memory files in a fresh module
instance and returns the named outputs:

```js
import createNiimath from '@niivue/niimath/niimath.js';
import { runNiimath } from '@neurodesk/node-drivers/niimath';

const { outputs } = await runNiimath(createNiimath, ['in.nii', '-s', '2', 'out.nii.gz'], {
  inputs: { 'in.nii': bytes },
  outputs: ['out.nii.gz'],
});
```

niimath gzips NIfTI output by default, so ask for `.nii.gz` names. A non-zero
exit or a missing output throws `NiimathError` with the module's log. Any
Emscripten `niimath.js` build works, including DWI2TRX's vendored dtifit build.

### MindGrab on the CPU

`loadMindgrabCpu` drives `@brainchop/mindgrab`'s threaded CPU modules
(Emscripten pthreads on `worker_threads`, weights compiled into the `.wasm`).
It returns `segment` and `segmentTissues` with the browser wrapper's options and
result shape. A `signal` option (an `AbortSignal`) terminates the run's worker thread
and rejects with the signal's reason. To use `runMindgrab` from `@neurodesk/brain-extraction`, pass the CPU
`segment` function and the version of that same package together in `runtime`.
Given a decoded input `volume`:

```js
import mindgrabPackage from '@brainchop/mindgrab/package.json' with { type: 'json' };
import { runMindgrab } from '@neurodesk/brain-extraction/mindgrab';
import { loadMindgrabCpu } from '@neurodesk/node-drivers/mindgrab';

const { segment } = await loadMindgrabCpu(import.meta.resolve('@brainchop/mindgrab/package.json'));
const { brain, mask, provenance } = await runMindgrab({
  volume,
  backend: 'cpu',
  runtime: { segment, version: mindgrabPackage.version },
});
```

`brain` and `mask` are decoded volumes; `provenance.version` records that MindGrab
package's version.

All four models run: `mindgrab`, `mindmap`, `mindsnap` and `16chan18cls`. Each
call runs in its own worker thread with one Emscripten thread per logical core,
and ending that thread frees the module's memory at once. On the 1 mm T1-weighted
example a call peaks at 2.6 GB (MindGrab) to 3.9 GB (MindMap tissues) and takes
30-70 s on eight cores. Calls in one process queue and run one at a time. GPU
backends, `device` and `glContext` are refused.

The driver calls the CPU modules directly instead of the published wrapper,
which refuses to run unless `globalThis.crossOriginIsolated` is true and loads
modules through browser `Worker`s. It mirrors the wrapper's argv construction
(`buildArgs`, not exported upstream) and validates options against the
package's own `MODELS`.

### brainchop-mindgrab command line

`bin/brainchop-mindgrab.js` is the native `brainchop-mindgrab` command line
(brainchopC) on the CPU driver, for Linux machines without that build. ME-ICA's
`meica --moco` (niivue/meica-rs) and fastprep run it as a subprocess:

```sh
brainchop-mindgrab ref.nii.gz -o stripped.nii.gz --mask mask.nii.gz --border 2
```

It reads `.nii` and `.nii.gz`, gzips each output whose name ends in `.gz`, and
writes the mask as uint8 on the input grid. The output defaults to
`output.nii.gz`; a bare `--mask` writes `mask.nii.gz`. It accepts `-o`/`--output`,
`--mask [PATH]`, `--border MM`, `--ct`, `--comply` and `-backend auto|cpu`.
`--crop`, `--export-classes` and `-cpu N` exit with status 2, as usage errors
do; a failed run exits with status 1. `-h` prints the MindGrab package version.
The tests fail when a MindGrab release adds an option the command line neither
accepts nor refuses.

The command line imports `@brainchop/mindgrab` from its own directory through
Node's resolution, or from the directory `BRAINCHOP_MINDGRAB_PACKAGE` names.
To install it without the monorepo, copy `bin/brainchop-mindgrab.js` and
`src/mindgrab.js`, `src/mindgrab-worker.js` and `src/mindgrab-cli.js` into one
directory, keeping `bin/` and `src/`, and install the MindGrab version this
package pins beside them with Node 22 or later:

```sh
cd /opt/brainchop-mindgrab
echo '{ "private": true, "type": "module" }' > package.json
npm install --no-audit --no-fund @brainchop/mindgrab@0.1.20260925
ln -s /opt/brainchop-mindgrab/bin/brainchop-mindgrab.js /usr/local/bin/brainchop-mindgrab
```

A run on a 2 mm, 83 x 105 x 80 volume takes about 40 s and peaks at 2.4 GB on
eight cores.

### Parity

`validation/reference.json` pins the outputs of the browser path: MindGrab's
CPU backend in Chromium on the brain-extraction app's T1-weighted example, and
niimath's WebAssembly in Chromium on a generated volume. The Node tests must
reproduce them byte for byte. MindGrab inference runs with
`MINDGRAB_PARITY=1`; the native niimath comparison runs with
`NIIMATH_NATIVE=/path/to/niimath`. `pnpm validate:browser` reruns the browser
side; without `--check` it rewrites the references.
`.github/workflows/node-drivers.yml` runs all of this on Linux, Windows and
macOS.

### dcm2niix

`convertDicom(files, glue, { onLog })` writes an in-memory DICOM series to
one fresh raw Emscripten dcm2niix instance and returns its NIfTI files as
`{ name, bytes }`. The caller supplies the URL of its pinned glue, for example
`new URL('dcm2niix.jpeg.js', import.meta.resolve('@niivue/dcm2niix'))`; the
driver reads the `.wasm` beside it.
It runs without browser globals or network downloads. Conversion exit codes
0 and 3 are accepted, as in the browser wrapper; other codes throw.
