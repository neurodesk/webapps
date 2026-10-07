# @neurodesk/browserqc

BrowserQC's quality-control pipeline, shared by the BrowserQC web app and the
`browserqc` command line: a MindGrab brain mask, a MindGrab segmentation, then
niimath's MRIQC-style `--qc` report with the pinned MNI air template.

`src/pipeline.js` holds the steps both runtimes take. `segmentForQc` runs the
brain mask and the model on the input's own grid through whichever MindGrab it
is given: the browser wrapper in the app's segmentation worker, or the Node CPU
driver from `@neurodesk/runtime-support/node/mindgrab` in the command line.
`qcTissues` turns the result into niimath's tissue arguments, `finishReport`
adds BrowserQC's provenance and the BIDS sidecar, and `AIR_TEMPLATE` pins the
template's URL and SHA-256. `src/models.json` is a copy of the app's model
catalog, which upstream BrowserQC owns; a test keeps the two identical.

## Command line

`browserqc` runs the web app's `quality-control` operation in Node. It runs the
same `@brainchop/mindgrab` 0.1.20260925 CPU modules and the same
`@niivue/niimath` 1.4.20260928 WebAssembly as the app. It needs no browser,
GPU or network.

### Install

Download the release for your platform from the web app's Standalone dialog:
Linux x64, Windows x64 or macOS on Apple silicon. Each contains a private
Node.js runtime, the MindGrab models and the air template.

On Linux, extract the archive and keep the directory intact:

```bash
tar -xzf browserqc-VERSION-linux-x64.tar.gz
./browserqc-VERSION-linux-x64/browserqc self-check
```

On Windows, use `Expand-Archive` and `browserqc.exe`.

On macOS, the release is an installer package signed with a Developer ID and
notarized by Apple. It installs the command line in
`/usr/local/lib/neurodesk/browserqc` and the `browserqc` command in
`/usr/local/bin`:

```bash
sudo installer -pkg browserqc-VERSION-macos-arm64.pkg -target /
browserqc self-check
```

To uninstall, delete `/usr/local/lib/neurodesk/browserqc` and
`/usr/local/bin/browserqc`, then run
`sudo pkgutil --forget org.neurodesk.browserqc`.

From a checkout of this repository:

```bash
pnpm install
node packages/browserqc/bin/browserqc.js --help
```

### Commands

```bash
browserqc T1w.nii.gz results
browserqc T1w.nii.gz results --model 16chan18cls --bids T1w.json
browserqc download-models
browserqc self-check
```

The options are the app's automation parameters:

| Option | Meaning |
| --- | --- |
| `--model NAME` | `mindmap-pve` (default): GM, WM and CSF fractions from MindMap. `16chan18cls`, `mindmap` or `mindsnap`: a label map, with the model's CSF and WM labels passed to niimath. |
| `--bids FILE` | A BIDS JSON sidecar, embedded in the report as `bids_meta`. |
| `--cache-dir DIR` | Where the air template is kept. Releases use their own `models/` directory. |
| `--offline` | Never download. Releases are offline by default. |

The command line always segments on the CPU. The app's `auto` backend uses
WebGPU when it can, and the release check compares only with the app's CPU
backend.

`download-models` fetches the air template. The MindGrab models are compiled
into the `@brainchop/mindgrab` WebAssembly modules, so they ship with the
package. The template is SHA-256 checked on every load.

Progress goes to standard error. Standard output lists the written files. The
output directory must be new or empty.

### Outputs

The command line writes the files the app's automation downloads, under the
same names:

| File | Content |
| --- | --- |
| `qc.json` | niimath's QC report, with `provenance.segmentation`, `provenance.air_template` and the optional `bids_meta` |
| `brain-mask.nii` | MindGrab brain mask, uint8, on the input grid |
| `csf.nii`, `gm.nii`, `wm.nii` | Tissue fractions, float32, on the input grid (`mindmap-pve`) |
| `labels.nii` | Label map on the input grid (label models) |

The command line reads NIfTI only. Convert DICOM with dcm2niix first. The app
also converts other formats through NiiVue, and offers manual ratings.

On the 1 mm example below, with eight cores, the default model takes about
two minutes and peaks at 4.0 GB of memory. Each MindGrab call runs in its own
worker thread with one thread per logical core.

### Release check

`validation/cli-check.mjs --executable PATH` runs a command line on the app's
pinned example (`t1_crop.nii.gz` and its sidecar) with `mindmap-pve` and
`16chan18cls`. It compares every download with the app's own, recorded in
`validation/reference.json` by `apps/browserqc/e2e/reference.spec.js` from the
built app's automation on its CPU backend in Chromium. Images must lie on the
input grid, have the reference's header, datatype and value domain, and match
its voxel sum, label counts and bytes. The QC report must have the same
metrics with the same values, the same provenance, and the sidecar as
`bids_meta`. Both runtimes run the same WebAssembly, so every comparison is
exact. `.github/workflows/browserqc-native.yml` first reruns the browser side
against the reference, then builds and checks every archive.

To record a new reference after changing the pipeline or a pinned package:

```bash
BROWSERQC_BROWSER_REFERENCE=write pnpm --filter browserqc exec playwright test e2e/reference.spec.js
```
