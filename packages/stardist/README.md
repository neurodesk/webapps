# @neurodesk/stardist

StarDist 2D and 3D star-convex nucleus segmentation core and portable command line, sharing its normalization, tiling, NMS, polygon/polyhedron rasterization, and TIFF/PNG I/O with `apps/stardist`.

## Command line

```sh
stardist image.tif results
stardist skin_he.png results --model 2D_versatile_he
stardist stack_3d.tif results --model 3D_demo
stardist download-models [--cache-dir DIR]
stardist self-check [--cache-dir DIR]
```

## Outputs

Writes `<stem>_stardist_labels.tif`, `<stem>_stardist_nuclei.csv`, and `<stem>_stardist_provenance.json` into `OUTPUT_DIR`.

## Models and offline execution

All four pinned ONNX models (`2D_versatile_fluo`, `2D_versatile_he`, `2D_paper_dsb2018`, `3D_demo`) are declared in `model.manifest.json`, SHA-256 verified on every load, and bundled in the portable release (`release.json`). Respects `NEURODESK_STARDIST_MODEL_DIR`, `NEURODESK_OFFLINE=1`, and sets `ORT_DISABLE_TELEMETRY=1` before loading ONNX Runtime.

## License

BSD-3-Clause (`LICENSE`, `NOTICE`).
