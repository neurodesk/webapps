# TopoFit

Browser and command-line packaging for BrainNet TopoFit 0.5.1. The package
preserves the pinned OpenRecon workflow's TReGA alignment, order-6 cortical
topology, bilateral
white/pial/registration surfaces, derived mid-surfaces, and source-grid QC output.

The model release is external. Create a Python 3.11 environment from
`requirements-export.txt`, then run:

```bash
python scripts/export_models.py /path/to/topofit-release
python scripts/publish_release.py /path/to/topofit-release
python scripts/activate_manifest.py /path/to/topofit-release HUGGING_FACE_COMMIT model.manifest.json
```

The exporter validates every learned ONNX boundary before it writes
`conversion-report.json`. Activation additionally requires the production
browser comparison in `validation/`. The checked-in manifest points to an
immutable dataset commit and records every runtime asset's byte count and
SHA-256.

The package owns one OpenRecon-compatible cubic B-spline conformer for both
browser and Node execution. It preserves nibabel's grid center, RAS axis
permutation/flips, normalized oblique rotation/shear, and effective scalar dtype.
Inputs already on an identity 1 mm grid bypass resampling, as in BrainNet.
The production worker cannot substitute a different conformer.
ONNX Runtime WebAssembly uses a fixed two threads on every machine. Thread count
changes how some operators split their sums: two threads reproduce the
single-thread outputs bit for bit, while four or more change rounding in TReGA
and white-surface orders 1-3. The count is constant rather than taken from the
host so every machine runs the same arithmetic.

`runTopofit` reconstructs the hemispheres one after the other unless the caller
passes `reconstructHemispheres`, which receives the feature maps and both
hemispheres' starting meshes and returns their white, pial and registration
vertices. The web app uses it to run `reconstructHemisphere` in two workers at
once; each hemisphere's model runs are unchanged, so the outputs are identical.

The downloaded processing manifest contains SHA-256 hashes for the
input, conformed tensor, model inputs, assets, and outputs; elapsed time is kept
outside that stable manifest.

The fresh production comparison on the pinned OpenNeuro scan measures
0.046 to 0.068 mm mean anatomical distance, below the 0.25 mm release limit.
See `validation/README.md` for the reproduction commands and limits.

## Command line

The `topofit` command runs the same pipeline on your own computer with ONNX
Runtime Node on the CPU. It needs no browser, GPU or Python.

### Install

Download the release for your platform from the TopoFit app's Standalone
dialog: Linux x64, Windows x64 or macOS on Apple silicon. Each contains a
private Node.js runtime and the T1-weighted models, so it runs offline from
the first use.

On Linux, extract the archive and keep the directory intact:

```bash
tar -xzf topofit-VERSION-linux-x64.tar.gz
./topofit-VERSION-linux-x64/topofit self-check
```

On Windows, use `Expand-Archive` and `topofit.exe`.

On macOS, the release is an installer package signed with a Developer ID and
notarized by Apple. It installs TopoFit in `/usr/local/lib/neurodesk/topofit`
and the `topofit` command in `/usr/local/bin`:

```bash
sudo installer -pkg topofit-VERSION-macos-arm64.pkg -target /
topofit self-check
```

You can also open the package in Finder. To uninstall, delete
`/usr/local/lib/neurodesk/topofit` and `/usr/local/bin/topofit`, then run
`sudo pkgutil --forget org.neurodesk.topofit`.

### Commands

```text
topofit INPUT.nii[.gz] OUTPUT_DIR [--model t1w-1mm] [--no-conform] [--threads N]
                                  [--cache-dir DIR] [--offline]
topofit download-models [--cache-dir DIR]
topofit self-check
topofit --help
```

`OUTPUT_DIR` must be new or empty. Inputs that are not on a 1 mm RAS grid are
conformed with the package's cubic B-spline; `--no-conform` refuses them
instead. `--threads` defaults to `SLURM_CPUS_PER_TASK`, or else every core.
Progress goes to standard error. An error prints one message and exits with
status 1. `self-check` prints a JSON report of the platform, Node and ONNX
Runtime versions and the runtime's path, and runs a one-node graph on the CPU.

`t1w-1mm` is the only preset. The synthetic-contrast graphs stay unavailable
until they have their own parity report. Surface normals, patch analysis, ROI
masks and DICOM input are available in the web app only.

### Models and offline use

Releases set `NEURODESK_TOPOFIT_MODEL_DIR` to their `models/` directory and
`NEURODESK_OFFLINE=1`. Installed from npm or the repository, the command
downloads the 22 T1-weighted files (95 MB) listed in `model.manifest.json` to
`~/.cache/neurodesk/topofit/<release>` (or `$XDG_CACHE_HOME`, or
`--cache-dir`) on first use. `download-models` fetches them ahead of time.
Every file's size and SHA-256 are checked on every load. A file that fails
the check stops the run and names the path to delete. With `--offline`, a
missing file stops the run instead of downloading.

### Outputs

The output directory receives the same files as the web app:
`lh.white`, `lh.mid.white`, `lh.pial`, `lh.registration` and the `rh.*` set
(FreeSurfer surfaces in scanner RAS mm, 245,762 vertices and 491,520 faces
each), `topofit_qc.nii` on the source grid, and `topofit_manifest.json`. The
manifest records the input, preprocessing, model-asset and output SHA-256 and
the runtime: `ONNX Runtime Node`, its version, `executionProvider: "cpu"` and
the thread count.

### Accuracy

`validation/cli-check.mjs` compares the command with the pinned OpenRecon
TopoFit 0.5.1 container on OpenNeuro ds000001 `sub-01_T1w`. Measured on Linux
x64 with ONNX Runtime 1.29.0: the conformed volume, alignment input and model
input are byte-identical to the validated browser run. Faces are identical.
Corresponding-vertex mean distance is 0.005 to 0.007 mm, p95 0.012 to 0.016 mm
and maximum 0.033 to 0.075 mm for white and pial surfaces; registration
spheres differ by 0.003 to 0.004 degrees on average. The release limits are
0.25 mm mean, 0.5 mm p95 and 2.0 mm maximum. Repeated runs with the same
thread count were byte-identical; another thread count changes the outputs'
low-order bits. The run took 54 s on 8 threads with 4.7 GB peak memory. Every
release must pass this check on its own platform; the macOS package runs it
after installation. One healthy scan is engineering evidence, not
clinical validation.

If you use TopoFit, please cite:

> Hoopes A, Iglesias JE, Fischl B, Greve D, Dalca AV. TopoFit: Rapid
> Reconstruction of Topologically-Correct Cortical Surfaces. Medical Imaging
> with Deep Learning, 2022.

## Mid-surfaces

Reconstruction always exports `lh.mid.white` and `rh.mid.white`, with IDs
`lh-mid` and `rh-mid`. Each uses its hemisphere's original triangle indices and
the corresponding white/pial vertex midpoints in scanner RAS millimetres.
Positions are computed in Float64 and stored as Float32 in FreeSurfer format.
The `.white` suffix lets mesh viewers recognize the file type; these files
contain the mid-surface, not the white boundary. Reanalysis retains their hashes.

## Surface analysis

Set `estimateNormals: true` to export bilateral mid-surface positions and unit
normals as CSV. Set `patches: {}` to enable OpenRecon's flat-patch search with
its defaults. `patches` accepts `radius`, `count`, `hemisphere`, `maxRms` and
`minAreaFraction`. `loadAtlas()` supplies the verified bytes from
`cortex-atlas.manifest.json`. An optional `roiBuffer` contains a native-grid
NIfTI mask; positive voxels restrict selection.

The search maps fsaverage cortex labels through the registration spheres,
erodes the medial-wall boundary by 5 mm along mesh edges, and excludes ribbon
separations below 0.5 mm. Connected candidates use a 10 mm geodesic radius by
default. Acceptance requires RMS at most 0.5 mm, area at least 25% of the radius
disc, and signed normal coherence at least 0.9. Accepted candidates are ranked
by `rms + radius × (1 − coherence)`, lowest first, with ties broken by seed
order; area does not affect the rank. Each hemisphere keeps the best-ranked
candidates that share no vertices with a higher-ranked patch, up to `count`
(default 3, at most 50), and numbers them in that order. Empty ROIs fail; failed quality searches return
`NO_PATCH_MEETS_CRITERIA` without lowering thresholds.

Each accepted patch has a viewable FreeSurfer mid-surface. The analysis JSON
records its RAS and LPS center and outward fitted-plane unit normal, area, RMS,
coherence, score and median ribbon separation. `topofit_patch_geometry.json`
contains source vertex indices, local triangles, paired white/mid/pial RAS
coordinates, local unit normals and ribbon separations. This is the container's
geometry schema in JSON instead of NPZ. CSV and JSON coordinates use millimetres;
normals are dimensionless. `center_vertex_index` identifies the mid-surface
member vertex nearest the area-weighted patch centroid; `center_ras_mm` is that
vertex's scanner RAS position. `normal_ras` is the unit fitted-plane normal,
oriented white-to-pial. `topofit_patch_coordinates_ras.csv` exports one row per
patch with that vertex index, RAS position and normal, area and plane-fit RMS.
A search with no accepted patches produces only its CSV header.

Per-vertex normals use all incident mid-surface
triangles and are individually oriented toward the corresponding pial vertex.

`topofit_patch_qc.nii` is a source-grid overlay with white boundaries at 2400,
pial boundaries at 2700, filled mid-surface triangles at 3000 and normal glyphs
at 4095. The browser supplies the original anatomy underneath. The 4 mm center
ring and 20 mm projected normal follow OpenRecon's source-slice convention.
Patch IDs are selectable result rows rather than rasterized image text.

Rebuild the atlas outside the repository:

```bash
python3 scripts/pack_cortex_atlas.py "$TMPDIR/topofit-atlas"
```

Compare against a downloaded OpenRecon recipe directory containing
`topofit_core.py` and `topofit_geometry.py`:

```bash
python3 scripts/verify_patch_parity.py "$TMPDIR/topofit-reference" \
  --surfaces "$TMPDIR/topofit-reference/surfaces" \
  --atlas "$TMPDIR/topofit-reference/atlas"
```

The atlas directory must also contain `lh.sphere.reg`, `rh.sphere.reg` and the
two original cortex labels, as in OpenRecon. The surfaces directory contains
bilateral white, pial and registration outputs. Validation covers local normals,
atlas mapping, medial-wall erosion, exact patch membership and geometry metrics.
Synthetic cases additionally compare triangle-to-voxel intersection masks.

### Repeat analysis after reconstruction

`runTopofit()` also returns `surfaces`, containing the reconstructed vertex arrays
and hemisphere face arrays. Retain it with the original source buffer and
provenance, then call `runSurfaceAnalysis({ buffer, surfaces, provenance,
estimateNormals, patches, roiBuffer, loadAtlas, cortexAtlasSha256, onProgress })`.
The analysis call returns analysis files and an updated processing manifest. It
does not invoke reconstruction or change the retained geometry. It replaces
previous analysis hashes and ROI/atlas metadata while preserving reconstruction
hashes. The browser retains this geometry only for the current loaded scan.
