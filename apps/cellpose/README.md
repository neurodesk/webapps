# Cellpose

Generalist 2D and 3D cell and nucleus segmentation in the browser using pretrained [Cellpose 3](https://github.com/MouseLand/cellpose) models (`cyto3` and `nuclei`), running locally with ONNX Runtime WebAssembly.

## Features

- **Two pretrained Cellpose 3 models:**
  - `cyto3` — generalist whole-cell and cytoplasm segmentation (fluorescence, phase contrast, brightfield) with optional nuclear guidance channel.
  - `nuclei` — dedicated nuclear stain segmentation.
- **2D and 3D support:** reads 2D TIFF, OME-TIFF and PNG images as well as multi-page / multi-channel 3D TIFF and OME-TIFF stacks (`ZCYX`, `ZYX`, `CYX`), running Cellpose's orthogonal-plane (`YX`, `ZY`, `ZX`) 3D flow averaging when 3D mode is enabled.
- **Interactive viewer:** NiiVue 2D and multiplanar 3D visualization with dual-channel composite rendering, filled or outline label overlays, and downloadable 32-bit TIFF label masks and per-object CSV measurements.
- **Zero-upload privacy:** models are fetched once from the pinned Neurodesk Hugging Face dataset with SHA-256 verification and cached locally.

## Development

```bash
pnpm --filter cellpose dev
pnpm --filter cellpose test
pnpm --filter cellpose lint
pnpm --filter cellpose build
pnpm --filter cellpose test:e2e
```

## Validation

Models and reference outputs are reproduced with:

- `validation/export_model.py` — exports Cellpose 3.1.1.1 PyTorch models (`cyto3`, `nuclei`) to dynamic-shape ONNX (opset 17) and verifies PyTorch vs. ONNX Runtime numerical agreement (`< 6e-5`).
- `validation/reference.py` — records Python Cellpose 3.1.1.1 outputs on the CC0 Allen Institute for Cell Science 2D and 3D examples (`validation/reference.json`).

## License

Application code and ported Cellpose algorithms are BSD-3-Clause (see `LICENSE` and `NOTICE`). Note that while Cellpose code and weights are BSD-3-Clause, parts of the `cyto3` training dataset carry non-commercial (CC-BY-NC) restrictions.
