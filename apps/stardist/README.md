# StarDist

Segments cell nuclei in one 2D fluorescence microscopy image with StarDist's pretrained
`2D_versatile_fluo` model (Schmidt et al., MICCAI 2018). Input is a TIFF, OME-TIFF or PNG; for
several channels or pages, the user picks one. Outputs are a label image (uncompressed TIFF,
16-bit or 32-bit, one id per nucleus) and a CSV table (`id, centroid_x, centroid_y, area_px,
mean_intensity, probability`), shown as filled labels or outlines over the image in NiiVue.

## Pipeline

| Step | Python StarDist 0.9.1 / csbdeep 0.8.1 | Here |
| --- | --- | --- |
| Normalization | `csbdeep.utils.normalize(img, 1, 99.8)` | `normalize` in `src/stardist.js` (numpy's linear percentile, float32 arithmetic) |
| Padding | `StarDistPadAndCropResizer`, reflect at the end to a multiple of 16 | `padImage` |
| Tiling | `Tiling.for_n_tiles`, overlap `ceil(94 / 16)` blocks | `axisTiles`, `predictCandidates` |
| Network | Keras U-Net | the same weights as ONNX (opset 17), ONNX Runtime Web 1.29 on WebAssembly |
| Candidates | `_predict_sparse_generator`, `b = 2` | `predictCandidates` |
| NMS | `c_non_max_suppression_inds` (Clipper 6.4.2 intersections) | `suppress` with `clipper-lib` 6.4.2, float32 arithmetic as in the C++ |
| Labels | `polygons_to_label`, `skimage.draw.polygon` | `polygonCoordinates`, `renderLabels` |
| Table | `skimage.measure.regionprops` | `measureNuclei` |

Automatic tiling uses one tile per 1024 pixels per axis; `tiles` sets the count as `n_tiles` does.
The worker (`src/worker.js`) runs one segmentation and is terminated to cancel.

## Validation

`validation/convert_model.py` converted the model; `validation/reference.py` ran Python StarDist
on the example and recorded `validation/reference.json`. Both ran in Python 3.10 with
tensorflow-cpu 2.15.1, stardist 0.9.1, csbdeep 0.8.1, tf2onnx 1.16.1, onnx 1.16.2, onnxruntime
1.19.2, scikit-image 0.25.2 and numpy 1.26:

```
python -I convert_model.py python_2D_versatile_fluo.zip <out>
python -I reference.py <out>/2D_versatile_fluo img2d.tif mask2d.tif reference.json [browser-labels.tif ...]
```

- ONNX against Keras on a random 256 × 320 input: max abs difference 1.3e-7 (probability) and
  3.8e-5 pixels (distances).
- Unit tests (`test/stardist.test.js`): percentiles equal numpy's; tiles equal csbdeep's for 25
  sizes and tile counts; on a 160 × 160 crop of the example, NMS keeps the same 9 of 369
  candidates and the label image has the same SHA-256 as StarDist's; labels drawn from the
  example's 118 polygons hash identically; areas and centroids equal regionprops.
- Browser (`e2e/workflow.spec.js`, production build, Chromium): the example gives 118 nuclei,
  the same as Python, with IoU-matched F1 1.0 untiled and with 2 × 2 tiles; the label image is
  identical pixel for pixel, and `stardist.matching` on the downloaded TIFFs agrees. The table's
  centroids, areas and mean intensities equal regionprops'. The test requires F1 ≥ 0.99 and a
  count within 1 %.
- Against the DSB 2018 annotation (125 nuclei) both give F1 0.971 at IoU 0.5 (precision 1.0,
  recall 0.944): the model leaves a few saturated, bright nuclei unsegmented.

Tied probabilities are the only known source of difference: numpy's unstable `argsort` orders
equal candidates arbitrarily, the port by index. None occurred on the example.

## Data and licences

- Model: `2D_versatile_fluo` from [stardist-models](https://github.com/stardist/stardist-models)
  v0.1 (`python_2D_versatile_fluo.zip`, sha256 `4ad678d0…46c3dd`), BSD-3-Clause, Copyright (c)
  2018-2024 Uwe Schmidt, Martin Weigert. The ONNX file is pinned in
  `models/stardist.manifest.json`.
- Example: StarDist's `test_image_nuclei_2d` (`stardist/data/images/img2d.tif`, 512 × 512, 16-bit),
  from the 2018 Data Science Bowl (BBBC038v1, CC0 1.0; Caicedo et al., Nature Methods 2019). Its
  annotation is pinned beside it under `stardist/validation/` on Hugging Face.
- Ported code: StarDist and CSBDeep are BSD-3-Clause; `clipper-lib` is the Boost Software
  License. This app is BSD-3-Clause.

## Not in v1

- Other StarDist models (`2D_versatile_he` for H&E, `2D_paper_dsb2018`), 3D StarDist (Weigert et
  al., WACV 2020) and custom models.
- WebGPU inference; the CPU build takes a few seconds on the example.
- An OME-Zarr label layer; only the label TIFF is written.
- Cellpose, for whole-cell segmentation, is future work.
