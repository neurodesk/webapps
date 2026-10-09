# @neurodesk/synthseg

SynthSeg 2.0 brain segmentation for browsers: FreeSurfer labels from any MRI
contrast or resolution, no retraining. Preprocessing and postprocessing are
`exes/synthseg`'s Rust modules compiled to WebAssembly — `wasm/src/lib.rs`
includes `nifti.rs`, `volume.rs` and `post.rs` by `#[path]` rather than copying
them, so browser output is bit-identical to the native CLI. Inference is the
caller's: `./browser` runs the shared WebGPU U-Net executor, and the Node tests
run onnxruntime-node.

```js
import { runSynthseg, loadSynthseg } from '@neurodesk/synthseg';
import { createBrowserSession, browserRuntime } from '@neurodesk/synthseg/browser';
import wasmUrl from '@neurodesk/synthseg/wasm?url';

const wasm = await loadSynthseg(fetch(wasmUrl));
const { buffer, provenance } = await runSynthseg({
  buffer,                       // ArrayBuffer of a .nii/.nii.gz
  options: { fast: false, ct: false },
  wasm,
  loadModel: async () => ({ bytes, hash }),   // synthseg-2.0.onnx, see model.manifest.json
  createSession: createBrowserSession,
  onProgress: (fraction, message) => {},
  runtime: browserRuntime(),
});
// buffer: .nii.gz int32 FreeSurfer labels on the 1 mm grid. provenance: the CLI's JSON sidecar fields.
```

`fast` skips left–right flip averaging and topology postprocessing (roughly half
the work, slightly noisier labels). `ct` clips Hounsfield units to [0, 80].

## Command line

The `synthseg` command runs the web app's pipeline on your own computer: the
same WebAssembly preprocessing and postprocessing, with ONNX Runtime Node on the
CPU in place of WebGPU. It needs no browser, GPU or Python.

### Install

Download the release for your platform from the SynthSeg app's Standalone
dialog. Linux x64 and Windows x64 get this command line. It contains a private
Node.js runtime and the SynthSeg 2.0 model, so it runs offline from the first
use. macOS on Apple silicon gets the native installer from `exes/synthseg`,
which runs the same model on Metal and takes the options `exes/synthseg`
documents.

```bash
tar -xzf synthseg-VERSION-linux-x64.tar.gz
./synthseg-VERSION-linux-x64/synthseg self-check
```

On Windows, use `Expand-Archive` and `synthseg.exe`.

### Commands

```text
synthseg INPUT.nii[.gz] OUTPUT_DIR [--mode default|fast] [--ct | --no-ct]
                                   [--threads N] [--cache-dir DIR] [--offline]
synthseg download-models [--cache-dir DIR]
synthseg self-check
synthseg --help
```

The options are the web app's automation parameters for `segment`
(`src/parameters.json`, which a test holds equal to `apps/synthseg/automation.json`).
`--mode fast` skips flip averaging and topology postprocessing. `--ct` treats the
input as CT in Hounsfield units and `--no-ct` as MRI. Without either, the input
counts as CT when any voxel is negative, as the app decides. The decision is
recorded in the report.

`OUTPUT_DIR` must be new or empty. `--threads` defaults to
`SLURM_CPUS_PER_TASK`, or else every core. Progress goes to standard error. A
finished run prints one JSON line with the output files, parameters, peak memory
and provenance. An error prints one message and exits with status 1. `self-check`
runs a one-node graph on ONNX Runtime's CPU provider, loads the WebAssembly
module and, in a release, verifies the bundled model. The command sets
`ORT_DISABLE_TELEMETRY=1` unless you set it.

### Memory and time

ONNX Runtime runs without its CPU memory arena or memory pattern planning,
which cut the peak from 9.3 GB to 6.1 GB on the example with identical labels.
Measured on `T1_head.nii.gz` (192×224×160 after padding), Linux x64, 8 threads
on a shared host:

| Mode | Peak resident memory | Wall time |
| --- | --- | --- |
| default | 6.1 GB | 101 s |
| fast | 4.4 GB | 45 s |

A larger field of view needs proportionally more. Plan for 8 GB of free memory.

### Models and offline use

Releases set `NEURODESK_SYNTHSEG_MODEL_DIR` to their `models/` directory and
`NEURODESK_OFFLINE=1`. Installed from the repository, the command downloads the
53 MB model to `~/.cache/neurodesk/synthseg/<model digest>` (or
`$XDG_CACHE_HOME`, or `--cache-dir`) on first use. `download-models` fetches it
ahead of time. Its size and SHA-256 are checked on every load, before any
computation. A file that fails the check stops the run and names the path to
delete. With `--offline`, a missing model stops the run instead of downloading.

### Outputs

The output directory receives the web app's two downloads, named by the same
code (`src/results.js`). For `T1.nii.gz`:

- `T1_synthseg.nii.gz`, int32 FreeSurfer labels on the 1 mm grid
- `T1_synthseg.json`, the app's run report: input and output checksums,
  parameters, provenance (model digest, ONNX Runtime version, threads, timings)
  and every label's voxel count and volume in ml

### Accuracy

`validation/cli-check.mjs --executable PATH` runs the command on both benchmark
volumes (`T1_head` at 1 mm and `T1_head_2mm`) in both modes. FreeSurfer 8.1.0's
`mri_synthseg` made the goldens, so the reference shares no code with the
command. Each label map must match its golden as `exes/synthseg/tests/parity.rs`
requires (`validation/gates.json`, read by that test, this package's tests and
the app's end-to-end test too): int32 labels, the same shape, sform within
1e-4 mm, the same qform/sform codes, units and quaternion, the same set of
labels, and at most 2e-6 of the voxels different. The report's voxel volume,
per-label volumes and total labelled volume must agree with the golden's to
within the differing voxels. `test/cli-check.test.js` shows each gate failing
on a golden with one defect. With `--native PATH`, the fast-mode maps are also
compared with the native Rust `synthseg` on the same input.

## Build and test

    make wasm    # cargo build --target wasm32-unknown-unknown + wasm-opt -O3 -> src/synthseg.wasm
    make test    # fixture parity against the FreeSurfer 8.1.0 goldens (needs exes/synthseg/models/synthseg-2.0.onnx)

`src/synthseg.wasm` is committed (as `packages/runtime-support/src/niimath` is),
so `make wasm` is only needed when the Rust changes. Without the model `make test`
still runs the wasm geometry check (catches ABI drift). Parity on the benchmark
volumes: `SYNTHSEG_REFERENCE_DIR=~/src/synthseg-references make test`.

The wasm ABI is plain C exports (`seg_new`, `seg_error_*`, `seg_input`, `seg_flipped_input`,
`seg_labels`, `seg_free`) plus typed accessors `seg_padded`, `seg_input_dims`,
`seg_output_dims` (u32×3) and `seg_affine` (f64×12); `src/wasm.js` assembles
`Segmenter.geometry` from them — no JSON crosses the boundary.

## Memory

The 33 posterior channels of a 1 mm head are ~0.9 GB, and the default mode holds
two sets while averaging, so the module is linked with `--max-memory=4 GiB` and
needs a 64-bit browser. `fast` mode halves the peak. The WebGPU executor retains
SynthSeg's validated 2 GiB single-buffer ceiling even when an adapter advertises
a larger limit; scans above it should use the native SynthSeg executable or a
smaller input until a separate large-buffer parity run extends that contract.

## Measured (Apple M4 Pro, Chromium via Metal, 192×224×160)

| Volume | Mode | Mismatched voxels | Wall time |
| --- | --- | --- | --- |
| T1_head | default | 1 of 5.6 M | 9.6 s |
| T1_head | fast | 0 | 7.7 s |
| T1_head_2mm | default | 0 | 9.3 s |
| T1_head_2mm | fast | 1 | 5.6 s |

Same mismatch counts as the native Metal executor (`exes/synthseg/validation/report.json`);
last run in `apps/synthseg/validation/report.json`. Inference is 6.3 s of the default run and
WASM postprocessing 3.0 s, so postprocessing is not the bottleneck. Planned GPU buffers total
5.2 GB (largest 1.85 GB, the full-resolution 72-channel concat); the largest volume under a
4 GB `maxBufferSize` is about 256×256×224. Engineering parity on named hardware, not a
performance claim.
