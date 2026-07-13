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
- **Interactive pipeline**: load input data, run SCT task inference, and inspect/download results
- **Configurable**: overlap, probability threshold, component size filtering
- **Smart auto-contrast**: percentile-based windowing for better default display
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
│   │   ├── controllers/   # FileIO, DICOM, Inference, Viewer
│   │   ├── modules/       # UI components and inference pipeline
│   │   ├── spinalcordtoolbox-app.js    # Main app
│   │   └── inference-worker.js   # Web Worker (3D inference pipeline)
│   ├── models/            # SCT model manifest + browser-runnable assets
│   └── index.html
└── README.md
```

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

## Privacy

Patient image data, DICOM metadata, filenames, intermediate volumes, masks,
segmentations, and downloaded outputs stay confidential and browser-local. The
application may collect telemetry for non-patient usage statistics, but telemetry
must not include patient-derived content.
