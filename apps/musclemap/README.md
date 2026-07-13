# MuscleMap Web App

Browser-based whole-body muscle segmentation using a MONAI 2D UNet model running entirely client-side via ONNX Runtime Web. Segments 99 muscles from MRI — no server required.

## Quick Start

```bash
# 1. Download ONNX Runtime WASM files
cd web
bash setup.sh

# 2. Start the development server
#    The MuscleMap ONNX models are already committed in web/models/.
bash run.sh
```

Open http://localhost:8080 in your browser.

## Usage

1. **Upload** a whole-body MRI as DICOM folder, NIfTI image, or NIfTI label map; use **Add File(s)** to append more NIfTI inputs
2. Assign each loaded NIfTI to its role: T1/T2 SE image, Dixon fat, Dixon water, Dixon opposed-phase, Dixon in-phase, or segmentation label map
3. Choose which image contrasts should run segmentation
4. Optionally adjust **sliding window overlap**, **slice thickness**, or enable **Low-Res Mode** in Inference Settings
5. Click **Run Segmentation**
6. Inspect each generated segmentation overlay independently in **Results**
7. In **Postprocessing**, optionally consolidate multiple segmentations into one label map
8. In **Postprocessing**, optionally calculate volumetric metrics or IMF metrics. T1/T2 SE metrics use K-means or Gaussian-mixture thresholding from one source image; Dixon metrics require both fat and water images and can be calculated alongside T1/T2 SE IMF.
9. **Download** segmentation NIfTI label maps or the metrics CSV

All processing happens locally in your browser. Patient data is not uploaded.

## Model Conversion

Convert a MuscleMap PyTorch checkpoint to ONNX:

```bash
pip install torch monai onnx onnxruntime

# FP32 (full precision, ~54 MB)
python scripts/convert_model.py --checkpoint /path/to/model.pth

# UINT8 quantized (~14 MB, faster download)
python scripts/convert_model.py --checkpoint /path/to/model.pth --quantize
```

Output is saved to `web/models/musclemap-wholebody.onnx`.

The ONNX files in `web/models/` are committed so the GitHub Pages deployment
can serve them directly from the same origin. Temporary PyTorch checkpoints used
for conversion are cached in `.tmp_weights/`, which is ignored by git.

## Project Structure

```
musclemap-webapp/
├── scripts/
│   └── convert_model.py              # PyTorch → ONNX conversion
├── web/
│   ├── index.html                     # Main page
│   ├── setup.sh                       # Downloads ONNX Runtime WASM
│   ├── run.sh                         # Dev server (Python, COOP/COEP headers)
│   ├── css/styles.css
│   ├── js/
│   │   ├── musclemap-app.js           # Main orchestrator
│   │   ├── inference-worker.js        # Web Worker (full inference pipeline)
│   │   ├── app/
│   │   │   ├── config.js              # Model config, inference params
│   │   │   └── labels.js              # 99 muscle labels + colors
│   │   ├── controllers/
│   │   │   ├── FileIOController.js    # NIfTI upload
│   │   │   ├── DicomController.js     # DICOM folder upload + conversion
│   │   │   ├── ViewerController.js    # NiiVue viewer
│   │   │   └── InferenceExecutor.js   # Worker lifecycle
│   │   └── modules/
│   │       ├── inference/
│   │       │   ├── preprocessing.js   # Orient, resample, normalize, crop
│   │       │   ├── sliding-window.js  # 2D sliding window + Gaussian weighting
│   │       │   ├── postprocessing.js  # Label cleanup, inverse transforms
│   │       │   └── connected-components.js
│   │       ├── file-io/
│   │       │   └── NiftiUtils.js
│   │       └── ui/
│   │           ├── ConsoleOutput.js
│   │           ├── ProgressManager.js
│   │           ├── ModalManager.js
│   │           └── MuscleLegend.js    # Detected muscles panel
│   ├── dcm2niix/                      # DICOM→NIfTI WASM module
│   ├── nifti-js/                      # NIfTI parser library
│   ├── wasm/                          # ONNX Runtime WASM (downloaded by setup.sh, ignored by git)
│   └── models/                        # ONNX models committed for GitHub Pages deployment
```

## Inference Pipeline

1. **Parse** NIfTI (supports gzip, multiple datatypes)
2. **Orient** to RAS using the affine matrix
3. **Resample** to 1×1mm in-plane (keep original z spacing)
4. **Normalize** intensity (z-score over nonzero voxels)
5. **Crop** foreground bounding box + 20-voxel margin
6. **Slice-by-slice 2D inference** with sliding window and Gaussian weighting
7. **Inverse transform + cleanup** — default mode inverse-transforms first and then runs connected components at full output resolution; optional Low-Res Mode cleans in the cropped working volume before inverse transforms
8. **Export** — write the segmentation back to original space for download and display

## Requirements

- A modern browser with WebAssembly support (Chrome, Firefox, Edge, Safari)
- Python 3 (for the development server only)
- For model conversion: `torch`, `monai`, `onnx`, `onnxruntime`

## Acknowledgements

Built on the [prostate-fiducial-seg](https://github.com/astewartau/prostate-fiducial-seg) web app template. Uses [NiiVue](https://github.com/niivue/niivue) for visualization, [ONNX Runtime Web](https://onnxruntime.ai) for inference, and [MONAI](https://monai.io) for the model architecture.
