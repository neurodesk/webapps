# @neurodesk/dermvit

Local 7-class HAM10000 dermoscopic skin lesion classification core (Vision Transformer `vit-base-patch16-224` dynamically quantized ONNX) and portable Node command line for the [DermViT](../../apps/dermvit) web application.

## Usage

```bash
dermvit self-check
dermvit download-models --cache-dir ./models
dermvit lesion.jpg out --color-constancy --saliency
```

## Outputs

- `<stem>_dermvit-predictions.csv` — ranked 7-class HAM10000 uncalibrated softmax scores and logits
- `<stem>_dermvit-provenance.json` — model SHA-256, preprocessing, runtime and score provenance
- `<stem>_dermvit-saliency.png` — optional 5×5 occlusion sensitivity overlay (with `--saliency`)

## Offline & environment variables

- `NEURODESK_DERMVIT_MODEL_DIR` — directory holding the verified `model_quantized.onnx` file
- `NEURODESK_OFFLINE=1` — refuse network downloads if the model is missing
- `ORT_DISABLE_TELEMETRY=1` — disables ONNX Runtime telemetry (set by default)

Research and educational use only — uncalibrated softmax scores are not a medical device or clinical diagnosis.
