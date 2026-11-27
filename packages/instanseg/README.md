# `@neurodesk/instanseg`

Browser inference pipeline for **InstanSeg** `brightfield_nuclei` (`instanseg_models_v0.1.1` / `instanseg` v0.1.2, Apache-2.0) over ONNX Runtime Web.

## Pipeline contract

- **Input:** Bounded 2D RGB brightfield microscopy image (TIFF, OME-TIFF, or PNG; at least `16 × 16`, up to 16 megapixels).
- **Pixel-size calibration:** When pixel size in µm/px is known (from TIFF/OME-TIFF metadata or user override) and differs from the model's `0.5 µm/px` training scale by more than 1%, the input is bilinear-resampled to `0.5 µm/px` before inference and the instance label map is nearest-neighbour resampled back to the original pixel grid.
- **Normalization & padding:** Per-channel `0.1–99.9` percentile normalization (`eps = 1e-3`), clamped to `[-2, 3]`, reflect-padded bottom/right to a multiple of 16.
- **Backbone (`instanseg-brightfield-nuclei.onnx`):** 2D `InstanSeg_UNet` (`m.fcn`, 3,824,780 params, exact float32 weights and compute, ~15.29 MB, opset 17: `Add`, `Concat`, `Constant`, `Conv`, `MaxPool`, `Relu`, `Resize`), outputting 5 dense channels (`dx`, `dy`, `sigma0`, `sigma1`, `seediness`).
- **Instance decoder:** Local seed maxima (`peakDistance = 5`, `seedThreshold = 0.7`), exact 61-parameter `ProbabilityNet` (`4 -> 5 -> 5 -> 1` ReLU MLP) over `64 × 64` per-seed windows, 8-connected fragment flood-fill & hole-filling (`cleanupFragments = true`), winner-takes-all pixel assignment (`maskThreshold = 0.53`), sparse Intersection-over-Minimum-Area (`IoMA > 0.3`) connected-component merging, and `512 × 512` overlap-tile stitching (`overlap = 80`, `max_cell_size = 20`, dual-IoU seam reconciliation `> 0.1`).
- **Outputs:** 16-bit (or 32-bit when > 65,535 nuclei) instance label TIFF with physical pixel spacing preserved, plus per-nucleus morphometry CSV (centroid, area in px and µm², equivalent diameter, bounding box).
