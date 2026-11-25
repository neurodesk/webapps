# @neurodesk/cellpose

Cellpose 3 2D and 3D generalist cell and nucleus segmentation core and portable command line, sharing its normalization, tiling, Euler flow dynamics, mask clustering, and TIFF/PNG I/O with `apps/cellpose`.

## Command line

```sh
cellpose image.tif results
cellpose cells.ome.tif results --model cyto3 --channel 1 --nuclear-channel 2 --diameter 60
cellpose stack.ome.tif results --model cyto3 --channel 1 --nuclear-channel 2 --diameter 30 --do-3d
cellpose download-models [--cache-dir DIR]
cellpose self-check [--cache-dir DIR]
```

## Outputs

Writes `<stem>_cellpose_labels.tif`, `<stem>_cellpose_cells.csv`, and `<stem>_cellpose_provenance.json` into `OUTPUT_DIR`.

## Models and offline execution

Both pinned Cellpose 3 ONNX models (`cyto3` and `nuclei`) are declared in `model.manifest.json`, SHA-256 verified on every load, and bundled in the portable release (`release.json`). Respects `NEURODESK_CELLPOSE_MODEL_DIR`, `NEURODESK_OFFLINE=1`, and sets `ORT_DISABLE_TELEMETRY=1` before loading ONNX Runtime.

## License

BSD-3-Clause (`LICENSE`, `NOTICE`).
