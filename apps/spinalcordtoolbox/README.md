# spinalcordtoolbox

Spinal cord MRI segmentation and analysis interface for [Spinal Cord Toolbox](https://spinalcordtoolbox.com/stable/). Segmentation runs in the browser. SCT morphometry and lesion analysis also run locally in the browser, with a compute-server option for native execution. SCT task metadata and model provenance are tracked in `web/models/manifest.json`.

## Quick Start

```bash
# 1. Download ONNX Runtime WASM files
cd web
bash setup.sh

# 2. Stage SCT model metadata and validate the browser manifest
python ../scripts/download_sct_models.py --stable --task spinalcord --output ../.tmp_sct_models
python ../scripts/convert_sct_models.py --input ../.tmp_sct_models --task spinalcord --output models
python ../scripts/validate_sct_models.py --manifest models/manifest.json

# 3. Start development server
bash run.sh
# Open http://localhost:8080
```

## Features

- **SCT stable task inventory** for spinal cord MRI segmentation workflows
- **Manifest-driven model provenance** with supported, unvalidated, unsupported, and retired task states
- **DICOM and NIfTI** input support
- **Several images of one patient**: load sessions side by side in Compare, each with its own results
- **Interactive pipeline**: load input data, run SCT task inference, and inspect/download results
- **Spine labels from TotalSpineSeg**: vertebrae, discs and disc points come from the `TotalSpineSeg` task; `sct_label_vertebrae` is not ported
- **SCT analysis**: cord morphometry (`sct_process_segmentation`) and lesion analysis (`sct_analyze_lesion`) of generated or uploaded masks, with SCT's own Python in the browser or the pinned SCT CLI on your compute server (see below)
- **Browser lesion metrics (approximate)**: SCIseg runs also report a quick local lesion table; it is not a substitute for SCT analysis
- **Manual correction**: Edit on a result row opens the shared mask editor in the viewer (draw, erase, fill, label, brush, undo); the edited mask replaces the result for download, display, Compare and SCT analysis
- **Configurable**: probability threshold, component size filtering
- **FreeBrowse viewer**: zoom and pan in 2D slices and the 3D render, layout selection, intensity window, per-layer opacity, colormap and visibility, and image download
- **Privacy**: segmentation stays in the browser; browser analysis stays local; native execution sends selected masks to your chosen compute server

## SCT Model Assets

```bash
python scripts/download_sct_models.py --stable --output .tmp_sct_models
python scripts/convert_sct_models.py --input .tmp_sct_models --output web/models
python scripts/validate_sct_models.py --manifest web/models/manifest.json --all-tasks
```

The default SCT task is `spinalcord`, matching the stable `sct_deepseg spinalcord` workflow. Tasks remain disabled in the browser until their model assets are converted to a browser-runnable format and validated against SCT stable behavior.

Supported states are recorded in `web/models/manifest.json`: `supported`, `unvalidated`, `unsupported`, and `retired`.

## Project Structure

```
spinalcordtoolbox/
├── .github/workflows/     # CI/CD (release + GitHub Pages deploy)
├── scripts/               # Model conversion, validation, and version scripts
├── web/
│   ├── js/
│   │   ├── app/           # Config and labels
│   │   ├── controllers/   # Input sessions and the inference pipeline adapter
│   │   ├── modules/       # Viewer (sct-viewer.js), 2D fallback preview, processing
│   │   ├── spinalcordtoolbox-app.js    # Main app
│   │   └── inference-worker.js   # Web Worker (3D inference pipeline)
│   ├── models/            # SCT model manifest + browser-runnable assets
│   └── index.html
└── README.md
```

## Viewer

The viewer is [FreeBrowse](https://github.com/freesurfer/freebrowse) around NiiVue 1.0, the same embedding TopoFit uses (`@neurodesk/runtime-support/freebrowse-viewer`). This app has no bundler, so `pnpm runtime-support` builds the viewer into `web/freebrowse-viewer/` and the page loads it from its own origin.

- **Zoom and pan**: choose **pan/zoom** beside "Right drag" in the viewer toolbar, then scroll to zoom and right-drag to pan. On a touch screen, pinch to zoom and drag with two fingers to pan, in any mode. In the 3D render the wheel always zooms. The ⟲ button resets view and contrast.
- **Layers**: the sidebar button opens the Volumes tab with visibility, opacity, intensity window and colormap for every layer, and Download for the current images. The Results eye buttons in the left sidebar toggle the same layers.
- **SCT's own toolbar** keeps only what FreeBrowse lacks: Single/Compare for multiple loaded images, and the PNG screenshot.
- **Compare** shows every loaded image side by side (up to four), for example a scan before and after surgery. Each panel is labelled with its file and shows that image's own results; the active image, the one Run and the Results list act on, is outlined and marked "active". Click a panel, or its title with the keyboard, to make it active. The layout menu applies to all panels. **Link views** (on by default) keeps slice, zoom, pan and crosshair in step by world (scanner mm) position, so scans of different size or orientation line up as far as their headers agree; follow-up scans are usually not registered, so turn it off to navigate each panel on its own.
- **Results per image**: running a task on one image keeps the results of the others. Results are kept for the active image and the three most recently used others; older ones are released, with a note in the Analysis log.
- **Editing a mask**: press **Edit** on a result row. A toolbar row opens under the viewer toolbar with **Draw**, **Erase** and **Fill** (outline a region; it fills on release), the **Label** to paint (by name for label maps), **Brush** size, **Undo**, **Apply** and **Cancel** (keys D, E, F, [ and ], Ctrl+Z). **Apply** makes the drawing the result: the Results row reads *(edited)*, the download is `<name>_edited.nii`, and SCT analysis offers the edited mask. The automatic browser lesion metrics are removed after an edit of the lesion or cord mask, because they described the model's mask. While the editor is open, FreeBrowse's own Drawing tab is shown but locked, so only one tool works on the drawing layer. An edit belongs to its image: switching images or opening Compare applies an open drawing to that image, and the edited result travels with the image's other results. A new run, Clear All, an example (which replaces every image) or a new image that would release an image's results asks first while an edit is not downloaded.
- Without WebGL2 the app shows a 2D axial preview instead; segmentation, results and downloads still work.

## Pipeline

1. Parse NIfTI / convert DICOM
2. Orient to RAS
3. Pad to task patch-size multiples
4. Z-score normalize
5. SCT task inference when a browser-runnable model asset is supported
6. Threshold probabilities
7. Inverse transforms (resize back to original dimensions)
8. Remove small connected components
9. Inverse orient -> output NIfTI

## Linting

A syntax checker runs before every GitHub Pages deploy to catch JS errors (e.g. `await` in non-async functions) that would silently break the webapp. You can run it locally:

```bash
npm install
npm run lint
```

This parses all JS files under `web/` using [acorn](https://github.com/acornjs/acorn) and reports any syntax errors with file, line, and column.

## Deployment

GitHub Pages publishes two builds:

- `/staging/` is rebuilt automatically from `main` on every push and displays
  the app version with a `-staging+<sha>` suffix.
- The live root app is built from the latest `vX.Y.Z` release tag.

To promote the currently staged `main` build to live, run the manual **Release**
workflow in GitHub Actions. It bumps `web/js/app/config.js`, tags the release,
creates or updates the GitHub release, and then the Pages workflow deploys that
tag to the live root while continuing to publish `main` at `/staging/`.

## Validation

Validate SCT model metadata and compare supported browser outputs against SCT stable behavior:

```bash
python scripts/validate_sct_models.py --manifest web/models/manifest.json --all-tasks
npm run test:fixtures:download
npm run test:fixtures
```

The fixture download script pulls `test_data/batch_processing.sh` and each
fixture `input.nii.gz` / `batch_output.nii.gz` pair from the Hugging Face
dataset `sbollmann/sct-webapp-data`. Browser-generated `browser_output.nii.gz`
files are not stored there; `npm run test:fixtures` regenerates them locally
when needed.

## Citations

If you use SCT workflows, please cite Spinal Cord Toolbox and the relevant SCT task/model references:

- **Spinal Cord Toolbox**: [spinalcordtoolbox.com](https://spinalcordtoolbox.com/stable/)
- **dcm2niix**: Li X, Morgan PS, Ashburner J, Smith J, Rorden C. The first step for neuroimaging data analysis: DICOM to NIfTI conversion. J Neurosci Methods. 2016;264:47-56. [GitHub](https://github.com/rordenlab/dcm2niix)
- **ONNX Runtime Web**: Microsoft. [onnxruntime.ai](https://onnxruntime.ai)
- **NiiVue**: NiiVue Contributors. [github.com/niivue/niivue](https://github.com/niivue/niivue)
- **FreeBrowse**: FreeSurfer developers. [github.com/freesurfer/freebrowse](https://github.com/freesurfer/freebrowse)

## Privacy

Local segmentation and browser SCT analysis keep patient images and intermediate results in the browser.
Native analysis uploads the selected masks and their NIfTI headers to your chosen
compute server, which retains inputs, results and logs until expiry or deletion.
Telemetry excludes patient-derived content.

## Morphometry and lesion analysis

Open **SCT analysis** to analyze uploaded NIfTI masks independently of an
anatomy image. Cord morphometry needs a cord mask. Lesion analysis needs a lesion
mask and accepts an optional cord mask. Current whole-cord and SCIseg lesion
results can also be selected. Gray matter and multiclass spine labels are not
whole-cord masks.

Choose **This browser** to run the original SCT Python analysis code in a dedicated
Pyodide WebAssembly worker. No server is required and masks stay on this device.
The pinned Python runtime loads when analysis starts. Cancellation terminates the
worker, and retry starts a fresh worker. Production and desktop bundles include
the verified SCT source and small dependencies. Python and scientific libraries
load from the versioned Pyodide CDN; the offline inventory pins their checksums.

The browser uses SCT 7.3 source unchanged, with fail-fast adapters for unavailable
OS APIs outside the supported analysis paths. It exports SCT's CSV/XLSX/pickle and
labeled NIfTI files. WebAssembly floating-point values are not guaranteed
bit-identical to native SCT. Measured synthetic and public SCT fixtures differed
by at most 1.8e-15 for morphometry; tested lesion measurements and label
voxels/affines matched exactly. Pickle serialization depends on Python/pandas
versions. Select **Compute server** for the pinned native execution path.

Connect a Neurodesk compute server running with Docker, then press **Run
analysis**. Only that action sends the selected masks, including their NIfTI
headers, to the server. Local segmentation continues to run in the browser.
The server retains jobs until deletion or expiry. **Previous analysis jobs**
lets you reopen results, cancel an active job through the footer, and delete a
terminal job and its files. Reconnect in the same browser tab to recover the
paired session after reload.

The registry-pinned image is
`vnmd/spinalcordtoolbox_7.3.3@sha256:974f6019415df81465ac03102d27b8a23945155b96a45e7b5f525a3d0d55ab83`.
It reports SCT **7.3** despite the image tag. Native and Apptainer compute-server
runners do not advertise this tool because they cannot guarantee the pinned
scientific dependency stack. Pull the image with Docker on the compute host
before the first analysis. No GPU is required.

The server runs upstream `sct_process_segmentation` or `sct_analyze_lesion`
without reorienting, thresholding, resampling or otherwise rewriting the input.
Morphometry exposes per-slice output, SCT slice ranges and angle correction.
Omitted settings retain upstream defaults. Other SCT flags, including vertebral
levels, atlas distribution, reference-image intensities and QC, are not exposed.

Morphometry downloads the native `morphometry.csv`. Lesion analysis downloads the
native `lesion_analysis.xlsx`, `lesion_analysis.pkl` and `lesion_label.nii[.gz]`.
The label image retains the input compression suffix. These native files are
preserved unchanged; the browser's morphometry preview does not rewrite the CSV.
Independent native runs include different timestamps and archive metadata, so
parity compares exact numerical/data fields and checks artifact bytes against
the originating run.

The automatic SCIseg **Browser lesion metrics (approximate)** result is the
existing local subset. It remains distinct from native SCT analysis. A server
started with `--runner simulate` exercises upload, cancellation and downloads
but returns clearly labelled placeholders with no scientific measurements.

### Verify native compatibility

Run a Docker compute server with this repository's binary, then set
`COMPUTE_SERVER_URL` and `COMPUTE_SERVER_TOKEN` and run
`pnpm --filter spinalcordtoolbox test:native-analysis`. Docker must also be
available locally for the independent CLI runs. Set `COMPUTE_SERVER_DATA` to the
server's local data directory to additionally compare download bytes with its
original artifacts. `DOCKER` can select another Docker executable.

The gate generates tilted, anisotropic, fractional and multi-lesion masks under
`TMPDIR`. It compares CSV fields, workbook contents, pickle tables and labeled
image data exactly, excluding run timestamps. It covers lesion masks with and
without a cord mask and both compressed and uncompressed NIfTI inputs. The gate
retains its inputs, outputs and job receipts for inspection.

### Compare browser and native exports

After staging the runtime with a production build, run
`pnpm --filter spinalcordtoolbox test:browser-parity` with local
Docker available. `DOCKER` can select another Docker executable. This runs the
delivered WebAssembly code and the pinned CLI independently, compares all
scientific fields, requires exact lesion-label voxels/affines and workbook
contents outside creation timestamps, and retains a per-field report under
`TMPDIR`. Numerical comparisons allow absolute and relative tolerances of
`1e-12`. `--exact` requires bit-identical numbers; `--report-only` records
differences without enforcing the numerical tolerance. Neither flag relaxes
checks of columns, rows, lesion labels, affines or workbook contents.
