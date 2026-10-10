# CALMAR command line

CALMAR prepares a stroke lesion candidate from a structural T1, then maps a
reviewed lesion through the selected atlas and group-connectivity pack. The
browser and command line share segmentation, PCA prealignment, registration,
overlap, connectivity and threshold helpers in this package.

## Command line

Portable Linux x64 and Windows x64 archives include Node, ONNX Runtime CPU,
SynthStrip, SynthStroke, the browser-pinned SynthMorph graph, MNI160, both atlases
and all connectivity shards. macOS arm64 releases use a signed and notarized
installer. The shared Standalone action displays published, verified releases.

```bash
calmar self-check
calmar prepare T1.nii.gz candidate-results --threads 4
```

`prepare` writes `candidate-lesion.nii` on the original T1 grid and
`provenance.json` with `requiresReview: true`. It uses the browser's fast
SynthStrip, PCA prealignment and eight-axis SynthStroke test-time augmentation,
with the same overlap, threshold and component cleanup settings. Preparation
never approves a candidate or continues into mapping.

Open the candidate and original T1 in a mask editor, inspect and correct the
lesion, then save a binary native-space mask. Mapping requires explicit approval:

```bash
calmar map reviewed-lesion.nii.gz mapping-results --reviewed \
  --structural T1.nii.gz --atlas schaefer400 --threads 4
```

With `--structural`, mapping checks that the reviewed mask matches the T1 grid,
then runs the browser's fast SynthStrip, PCA prealignment, masked SynthMorph
normalization, seven-step SVF integration, mask warp and nearest atlas resampling.
Inspect the registered `reviewed-lesion-atlas.nii`; PCA and the browser-sized
registration graph have the same limitations as the web app.

If a reviewed lesion is already on the selected atlas grid, omit `--structural`:

```bash
calmar map reviewed-atlas-lesion.nii.gz mapping-results --reviewed --atlas yeo7
```

Dimensions and affine must match the selected overlap atlas within 0.001 mm.
The command refuses to guess a space from dimensions alone. Inputs must be
single 3D NIfTI volumes; reviewed masks must contain only zero and one. The
output directory must be new or empty.

Mapping writes `reviewed-lesion-atlas.nii`, `lnm-network-map.nii`,
`lnm-network-map-thresh.nii`, `lnm-overlap.csv` and `provenance.json`.
Schaefer400 weights the hit parcels and produces the FC map on its 4 mm grid;
Yeo7 weights network overlap on its 2 mm grid. The default symmetric threshold
retains the top 5% of absolute map values. `--threshold` sets the quantile,
for example `0.95` for the top 5%; `--min-cluster` removes smaller clusters and filters smaller overlap rows; its default is 30 voxels, matching the browser.

## Source and offline use

```bash
pnpm --filter @neurodesk/calmar exec calmar download-models --cache-dir /data/calmar-models
NEURODESK_CALMAR_MODEL_DIR=/data/calmar-models NEURODESK_OFFLINE=1 calmar self-check
```

`download-models` verifies every byte count and SHA-256 against immutable URLs
in `assets.lock.json`. The portable launcher selects its bundled model directory
and offline mode. Missing or corrupt assets fail before writing results; offline
execution never repairs or populates caches. Source installs use a cache named
for the asset set or `NEURODESK_CALMAR_MODEL_DIR`. `--cache-dir` selects another
prepared directory. DeepISLES remains benchmark-only and is not installed or
accepted as a command-line method.

CALMAR is research software. Review masks and registration before interpreting
network maps. Model provenance and method citations are in the
[app README](../../apps/calmar/README.md).

## Release validation

`validation/cli-check.mjs` runs the extracted executable with offline mode and
an empty home. It compares the prepared candidate with a live production
Chromium/ONNX Runtime Web CPU run on the checksummed structural example. The
runtime Dice gate is 0.995; the existing independent real-stroke fixture keeps
its scientific Dice gate of 0.50. The first local comparison measured 0.9982
runtime Dice and 0.6121 against the scientific reference.

Mapping is checked against the independent Visual FC identity reference, the
default Schaefer shard channel, and the complete native-to-atlas reviewed-mask
bridge. Existing Python/Node registration, resampling and FC references remain
in the app's test suite. The native workflow provisions Chromium and builds the
production app before validating Linux, Windows and macOS archives.

To run the release check locally after building CALMAR and installing Chromium:

```bash
pnpm --filter calmar build
NEURODESK_CALMAR_MODEL_DIR=/data/calmar-models node packages/calmar/validation/cli-check.mjs
```

Use `--executable /path/to/extracted/calmar` to test a portable archive. Browser
validation dependencies are development tools and are not included in archives.
