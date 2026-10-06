# spinalcordtoolbox

Browser-based spinal cord MRI segmentation interface for [Spinal Cord Toolbox](https://spinalcordtoolbox.com/stable/) stable segmentation workflows. Patient image data stays local in the browser; SCT task metadata and model provenance are tracked in `web/models/manifest.json`.

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
- **Morphometry** (`sct_process_segmentation`): cross-sectional area, AP and RL diameter, eccentricity, orientation, solidity, cord angles and length of any mask of the session, per slice, per vertebral level or aggregated, as a CSV in SCT's column layout
- **Lesion metrics** (`sct_analyze_lesion -m -s -i`): volume, length, width, equivalent diameter, axial damage ratio, midsagittal measures and tissue bridges for every lesion, as a CSV with SCT's `measures` columns
- **Configurable**: overlap, probability threshold, component size filtering
- **FreeBrowse viewer**: zoom and pan in 2D slices and the 3D render, layout selection, intensity window, per-layer opacity, colormap and visibility, image download, and a Drawing tab
- **Privacy**: patient image data stays confidential and browser-local; non-patient usage statistics may be collected as telemetry

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

## Metrics and SCT parity

Morphometry and lesion analysis are ports of SCT 7.3, not approximations. `web/js/modules/sct-centerline.js` carries a port of FITPACK's smoothing spline (what SciPy's `splrep` runs), because every angle correction in SCT comes from that fit; `sct-morphometry.js` and `lesion-analysis.js` then follow `process_seg.py`, `aggregate_slicewise.py` and `sct_analyze_lesion.py` step by step.

Both are also automation operations on mask files (`morphometry`, `lesion-metrics` in `automation.json`), so a mask from any source can be measured without inference.

`npm run test:metrics:parity` compares both modules with tables written by the real tools in the pinned container (`vnmd/spinalcordtoolbox_7.3.3:20260902`): 15 `sct_process_segmentation` runs (665 rows over six masks, three voxel sizes and three stored orientations) and 3 `sct_analyze_lesion` runs (6 lesions). Every number agrees to better than 1e-11; the test allows 1e-9. Regenerate the tables with `npm run test:metrics:references` (needs Docker).

What the browser does differently from SCT:

- Not ported from `sct_process_segmentation`: `-anat` (HOG angle, quadrant areas, symmetry), `-pmj`/`-pmj-distance`/`-pmj-extent`, `-normalize`, `-normalize-PAM50`, `-centerline`, the `polyfit`/`linear`/`nurbs` centerline fits, `-vertfile`, `-append` and the QC report. The centerline is always the B-spline with SCT's default smoothing.
- Not ported from `sct_analyze_lesion`: `-f` (lesion distribution over a registered PAM50 atlas), `-perslice`, `-nli-slice`, the QC report, and the `.xlsx`/`.pkl` outputs (one CSV instead).
- The "SCT Version" column says `7.3 (Neurodesk web port <version>)`, and "Filename" is the mask's file name without a path.
- Where SCT stops with an error (no lesion, or a lesion wholly outside the cord) the app returns the lesions it can measure and logs a warning.
- When a projected disc is equally far from two centerline voxels, SCT's choice depends on floating-point rounding of the affine; the app takes the voxel on the disc's own slice, which is what SCT chose on every reference case.
- TotalSpineSeg disc markers are small spheres; morphometry reduces each to its centre voxel, as `-discfile` expects single-voxel labels.
- Lesion image statistics use the image as the worker holds it (float32); for a float64 image SCT's mean and standard deviation can differ in the last digits.

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

Patient image data, DICOM metadata, filenames, intermediate volumes, masks,
segmentations, and downloaded outputs stay confidential and browser-local. The
application may collect telemetry for non-patient usage statistics, but telemetry
must not include patient-derived content.
