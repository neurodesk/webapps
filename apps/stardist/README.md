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
  candidates and the label image has the same SHA-256 as StarDist's; padding equals
  `numpy.pad(mode="reflect")` for four shapes; on a 157 × 203 crop (not a multiple of 16), NMS
  keeps the same 13 of 548 candidates and the labels hash as `predict_instances`'; labels drawn
  from the example's 118 polygons hash identically; areas and centroids equal regionprops.
- Browser (`e2e/workflow.spec.js`, production build, Chromium): the downloaded label image has
  the SHA-256 of Python's, untiled and with 2 × 2 tiles (118 nuclei), and on the 157 × 203 crop,
  which goes through the padding (548 candidates, 13 nuclei). The table's centroids, areas and
  mean intensities equal regionprops'. The IoU-matched F1 is logged to size a failure.
- Against the DSB 2018 annotation (125 nuclei) both give F1 0.971 at IoU 0.5 (precision 1.0,
  recall 0.944): the model leaves a few saturated, bright nuclei unsegmented.

Tied probabilities are the only known source of difference: numpy's unstable `argsort` orders
equal candidates arbitrarily, the port by index. None occurred on the example.

Inputs of `reference.py`, pinned in `validation/reference.json` (image and mask):

| File | URL | SHA-256 |
| --- | --- | --- |
| Image | `https://huggingface.co/datasets/neurodeskorg/webapps/resolve/e76a7bbd831da2bfdae49058700da81d6cca577c/stardist/example/dsb2018-nuclei-2d.tif` | `f9ccc1571b92c861ff87e28463068b43f61bd47357ed0503f711e5cd1eb97750` |
| Mask | `https://huggingface.co/datasets/neurodeskorg/webapps/resolve/e76a7bbd831da2bfdae49058700da81d6cca577c/stardist/validation/dsb2018-nuclei-2d-mask.tif` | `59ad5e820b7982ca9d13e946fa6e7f64e2714899e00a2ae6c69aa79aad53d46f` |
| Model | `https://github.com/stardist/stardist-models/releases/download/v0.1/python_2D_versatile_fluo.zip` | `4ad678d0758eed6e55625f1b5ae30771e59adb79f1239e09b9772eac8846c3dd` |

## Data and licences

- Model: `2D_versatile_fluo` from [stardist-models](https://github.com/stardist/stardist-models)
  v0.1 (`python_2D_versatile_fluo.zip`, sha256 `4ad678d0…46c3dd`), BSD-3-Clause, Copyright (c)
  2018-2024 Uwe Schmidt, Martin Weigert. The ONNX file is pinned in
  `models/stardist.manifest.json`.
- Example: StarDist's `test_image_nuclei_2d` (`stardist/data/images/img2d.tif`, 512 × 512, 16-bit),
  from the 2018 Data Science Bowl (BBBC038v1, CC0 1.0; Caicedo et al., Nature Methods 2019). Its
  annotation is pinned beside it under `stardist/validation/` on Hugging Face.
- Ported code: StarDist and CSBDeep are BSD-3-Clause; `clipper-lib` is the Boost Software
  License. This app is BSD-3-Clause (`LICENSE`); `NOTICE` holds the attributions and the Boost
  licence, and the build ships both at the app's root.

## Not in v1

- Other StarDist models (`2D_versatile_he` for H&E, `2D_paper_dsb2018`), 3D StarDist (Weigert et
  al., WACV 2020) and custom models.
- WebGPU inference; the CPU build takes a few seconds on the example.
- An OME-Zarr label layer; only the label TIFF is written.
- Cellpose, for whole-cell segmentation, is future work.
