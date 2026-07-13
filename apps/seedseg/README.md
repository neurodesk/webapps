# Prostate gold seed segmentation

Deep learning segmentation of gold fiducial markers in T1-weighted prostate MRI using a consensus of 4 3D UNet models.

## Structure

- `scripts/` - Python pipeline: preprocessing, training, inference, evaluation, analysis
- `web/` - Browser-based inference app (ONNX Runtime Web + NiiVue)
- `models/` - PyTorch model checkpoints (not tracked)
- `paper_draft/` - Manuscript and figures

## Web app

The `web/` directory contains a browser-based version of the inference pipeline. All computation runs locally in the browser using ONNX Runtime Web (WASM backend). No data is uploaded to any server.

### Setup

```bash
# 1. Download ONNX Runtime WASM files
cd web && bash setup.sh

# 2. Convert PyTorch models to ONNX (from project root)
cd .. && python scripts/convert_models.py

# 3. Start development server
cd web && bash run.sh
```

Then open http://localhost:8080 and upload a T1-weighted prostate MRI (NIfTI or DICOM).

## Python pipeline

### Training

```bash
python scripts/training/train_one_model.py T1 --mode production --seed 42 \
    --data-dir data/train --val-dir data/test/prepared \
    --val-subjects data/val_subjects.txt --output-dir models/
```

### Inference

```bash
python scripts/inference/consensus_inference.py \
    --models models/T1-*-best.pth --input scan.nii --output results/
```

## Citation

Stewart et al. "Deep-Learning-Enabled Differentiation between Intraprostatic Gold Fiducial Markers and Calcification in Quantitative Susceptibility Mapping." bioRxiv (2023). https://doi.org/10.1101/2023.10.26.564293
