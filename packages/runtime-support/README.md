# @neurodesk/runtime-support

Browser runtime wrappers shared by the web apps, and two Node drivers that let
a portable command line run the same WebAssembly as its app.

## Node drivers for command lines

Both drivers take the build the caller pins, so a command line runs the bytes
its web app runs. Add the package to the command line's own dependencies at the
app's version.

### niimath

`runNiimath` runs one niimath argv over in-memory files in a fresh module
instance and returns the named outputs:

```js
import createNiimath from '@niivue/niimath/niimath.js';
import { runNiimath } from '@neurodesk/runtime-support/node/niimath';

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
It returns `segment` and `segmentTissues` with the wrapper's options and result
shape, so code written against the browser wrapper, such as
`runMindgrab({ segmenter })` in `@neurodesk/brain-extraction`, can take it:

```js
import { loadMindgrabCpu } from '@neurodesk/runtime-support/node/mindgrab';

const mindgrab = await loadMindgrabCpu(import.meta.resolve('@brainchop/mindgrab/package.json'));
const { image, mask } = await mindgrab.segment(niftiBytes, { model: 'mindgrab', mask: true });
```

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
