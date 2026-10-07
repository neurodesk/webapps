# @neurodesk/white-matter-lesions

FLAMeS white matter lesion segmentation from one FLAIR image, shared by the
[White matter lesions web app](../../apps/white-matter-lesions) and the `flames`
command line. The package holds the pipeline (`src/pipeline.js`, nnU-Net's
inference for FLAMeS with the ONNX Runtime session injected), the output writer
(`src/results.js`), the model pins (`model.manifest.json`, a copy of
`models/white-matter-lesions.manifest.json`, and SYNcro's browser SynthStrip
graph) and the Node adapter (`src/node.js`).

## Command line

The `flames` command runs the web app's pipeline on your own computer with ONNX
Runtime Node on the CPU. It needs no browser, GPU or Python.

### Install

Download the release for your platform from the White matter lesions app's
Standalone dialog: Linux x64, Windows x64 or macOS on Apple silicon. Each
contains a private Node.js runtime, SynthStrip and all five FLAMeS folds, so it
runs offline from the first use.

On Linux, extract the archive and keep the directory intact:

```bash
tar -xzf flames-VERSION-linux-x64.tar.gz
./flames-VERSION-linux-x64/flames self-check
```

On Windows, use `Expand-Archive` and `flames.exe`.

On macOS, the release is an installer package signed with a Developer ID and
notarized by Apple. It installs FLAMeS in `/usr/local/lib/neurodesk/flames`
and the `flames` command in `/usr/local/bin`:

```bash
sudo installer -pkg flames-VERSION-macos-arm64.pkg -target /
flames self-check
```

You can also open the package in Finder. To uninstall, delete
`/usr/local/lib/neurodesk/flames` and `/usr/local/bin/flames`, then run
`sudo pkgutil --forget org.neurodesk.flames`.

### Commands

```text
flames INPUT.nii[.gz] OUTPUT_DIR [--folds 1|5] [--skull-stripped] [--threads N]
                                 [--cache-dir DIR] [--offline]
flames download-models [--cache-dir DIR]
flames self-check
flames --help
```

The options are the web app's automation parameters for `segment`. `--folds 1`
(the default) runs fold 0; `--folds 5` runs the published five-fold ensemble.
`--skull-stripped` uses nonzero input voxels as the brain mask instead of
SynthStrip. The web app's `backend` parameter has no equivalent: the command
always runs on the CPU.

`OUTPUT_DIR` must be new or empty. `--threads` defaults to
`SLURM_CPUS_PER_TASK`, or else every core. Progress goes to standard error. A
finished run prints one JSON line with the output files, lesion count, total
volume in ml and its provenance (models, brain mask, ONNX Runtime version,
`executionProvider: "cpu"`, threads and seconds). An error prints one message
and exits with status 1. `self-check` prints a JSON report of the platform,
Node and ONNX Runtime versions and the runtime's path, and runs a one-node graph
on the CPU. The command sets `ORT_DISABLE_TELEMETRY=1` unless you set it, so ONNX
Runtime writes nothing under your home directory.

DICOM input and mask editing are available in the web app only.

### Models and offline use

Releases set `NEURODESK_FLAMES_MODEL_DIR` to their `models/` directory and
`NEURODESK_OFFLINE=1`. Installed from npm or the repository, the command
downloads SynthStrip (10 MB) and the five folds (5 × 62 MB) to
`~/.cache/neurodesk/flames/<model set>` (or `$XDG_CACHE_HOME`, or
`--cache-dir`) on first use. `download-models` fetches them ahead of time.
Every file's size and SHA-256 are checked on every load, and every model a run
needs is checked before it starts. A file that fails the check stops the run
and names the path to delete. With `--offline`, a missing file stops the run
instead of downloading.

### Outputs

The output directory receives the web app's three downloads, under the same
names and written by the same code (`src/results.js`). For `flair.nii.gz`:

- `flair_lesions.nii`, the uint8 lesion mask (probability above 0.5)
- `flair_lesion_probability.nii`, the float32 lesion probability
- `flair_lesions.tsv`, one row per 26-connected lesion: voxels, volume in ml
  and centroid in scanner coordinates

Both images keep the input grid and affine.

### Accuracy

`validation/cli-check.mjs` runs the command on the app's pinned example
(MSLesSeg P57, a clinical 2.3 mm FLAIR) with `--folds 1` and `--folds 5`. It
checks each run in two ways.

- Against the web app's results, recorded in Chromium by the app's end-to-end
  test and stored in `apps/white-matter-lesions/validation/browser-reference.json`.
  The mask must be binary and equal to the probability above 0.5. The
  probability must be finite and within [0, 1]. The lesion count must be within
  2 of the browser's. The mask voxels, lesion volume and summed probability
  (in ml) must be within 1 % of the browser's. The browser run shares no
  process with the check, so a regression in the shared pipeline fails here.
- With `--folds 1` only, against the web app's worker path on ONNX Runtime Web's
  WebAssembly backend (`validation/web-reference.mjs`), voxel by voxel. The
  file names and NIfTI headers must be identical, the table must be the app's
  table of the command's mask, and the masks must agree at Dice 0.998 or
  better. That limit is the cross-runtime agreement the app's port check
  measured (`apps/white-matter-lesions/validation/README.md`): two ONNX
  Runtimes round floats differently, and that is the only difference here. No
  probability may differ by more than 0.1.

Measured on Linux x64 with ONNX Runtime 1.29.0 and one fold: Dice 0.99948, with
13 of 12,614 lesion voxels differing. Both find 90 lesions (31.48 ml against
31.50 ml), and the largest probability difference is 0.036, the same on all three
release platforms. Repeated runs on 8
and 3 threads were byte-identical. The packaged run took 65 s on 8 threads with 4.8 GB
peak memory. Every release must pass this check on its own platform. One scan
is engineering evidence, not clinical validation.

If you use FLAMeS, please cite:

Dereskewicz E, La Rosa F, dos Santos Silva J, et al. FLAMeS: a robust deep
learning model for automated multiple sclerosis lesion segmentation. medRxiv.
2025. https://doi.org/10.1101/2025.05.19.25327707
