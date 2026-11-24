# StarDist

Segments cell nuclei in 2D fluorescence, 2D H&E brightfield and 3D fluorescence microscopy with
StarDist's four official pretrained models (Schmidt et al., MICCAI 2018; Weigert et al., WACV 2020):

| Model | Modality | Input | Rays | Grid | Default thresholds |
| --- | --- | --- | --- | --- | --- |
| `2D_versatile_fluo` | 2D fluorescence nuclei (DSB 2018) | 1-channel TIFF, OME-TIFF, PNG | 32 | 2 × 2 | prob 0.479, NMS 0.3 |
| `2D_versatile_he` | 2D H&E brightfield histology (MoNuSeg + TNBC) | 3-channel RGB PNG or TIFF | 32 | 2 × 2 | prob 0.692, NMS 0.3 |
| `2D_paper_dsb2018` | 2D fluorescence nuclei (2018 paper model) | 1-channel TIFF, OME-TIFF, PNG | 32 | 1 × 1 | prob 0.418, NMS 0.5 |
| `3D_demo` | 3D fluorescence nuclei (synthetic demo) | Multi-page 3D TIFF / OME-TIFF | 96 (GoldenSpiral) | 1 × 2 × 2 | prob 0.708, NMS 0.3 |

Outputs are a label image (uncompressed 16-bit or 32-bit TIFF, with an ImageJ Z-stack header for
3D volumes) and a CSV table (`id, centroid_x, centroid_y, area_px, mean_intensity, probability` in
2D; `id, centroid_x, centroid_y, centroid_z, volume_vox, mean_intensity, probability` in 3D), shown
as filled labels or outlines over the image in NiiVue (2D axial, full-colour RGBA for H&E, and
3-plane multiplanar for 3D stacks).

## Pipeline

| Step | Python StarDist 0.9.1 / csbdeep 0.8.1 | Here |
| --- | --- | --- |
| Normalization | `csbdeep.utils.normalize(img, 1, 99.8)` (joint across RGB) | `normalize` in `src/stardist.js` (numpy linear percentile, float32) |
| Padding | `StarDistPadAndCropResizer`, reflect at the end to `div_by` | `padImage` (2D) / `padVolume` (3D) |
| Tiling | `Tiling.for_n_tiles`, overlap `ceil(tile_overlap / div_by)` blocks | `axisTiles`, `predictCandidates` / `predictCandidates3D` |
| Network | Keras U-Net (2D) or ResNet (3D) | the same weights as ONNX (opset 17), ONNX Runtime Web 1.29 on WebAssembly |
| Candidates | `_predict_sparse_generator`, `b = 2` | `predictCandidates` / `predictCandidates3D` |
| 2D NMS | `c_non_max_suppression_inds` (Clipper 6.4.2 intersections) | `suppress` with `clipper-lib` 6.4.2, float32 arithmetic |
| 3D NMS | `_COMMON_non_maximum_suppression_sparse` (`use_bbox`, `use_kdtree`) | `suppress3D` in `src/stardist3d.js` (isotropic sphere/bbox bounds, continuous kernel/convex-hull tests, and exact voxel overlap) |
| Labels | `polygons_to_label` (2D) / `polyhedron_to_label` (3D) | `renderLabels` (2D) / `renderLabels3D` (3D) |
| Table | `skimage.measure.regionprops` | `measureNuclei` (2D) / `measureNuclei3D` (3D) |

Automatic tiling uses one tile per 1024 pixels per axis in 2D and splits 3D stacks so each overlapped tile's output stays within 64 MiB.
The worker (`src/worker.js`) runs one segmentation and is terminated to cancel.

## Validation

`validation/convert_model.py` converted all four models; `validation/reference.py` ran Python
StarDist on the examples and recorded `validation/reference.json`. Both ran in Python 3.10 with
tensorflow-cpu 2.15.1, stardist 0.9.1, csbdeep 0.8.1, tf2onnx 1.16.1, onnx 1.16.2, onnxruntime
1.19.2, scikit-image 0.25.2, setuptools < 81 and numpy 1.26:

```
python -I convert_model.py python_<name>.zip <out>
python -I reference.py <models-dir> reference.json [browser-labels.tif ...]
```

- ONNX against Keras max abs diff:
  - `2D_versatile_fluo`: 1.3e-7 (prob), 3.8e-5 px (dist)
  - `2D_versatile_he`: 4.5e-7 (prob), 7.6e-5 px (dist)
  - `2D_paper_dsb2018`: 1.0e-6 (prob), 1.9e-4 px (dist)
  - `3D_demo`: 7.5e-7 (prob), 1.8e-5 vox (dist)
- Unit tests (`test/stardist.test.js`): 2D percentiles, tiling, reflect padding (1-channel and
  3-channel RGB), NMS, cropped/padded NMS, polygon rendering and regionprops; 3D reflect padding,
  3D NMS and polyhedron rendering matching Python StarDist 0.9.1 voxel for voxel (30 nuclei from
  302 candidates, identical SHA-256), 3D regionprops and 3D tiled prediction.
- Browser (`e2e/workflow.spec.js`, production build, Chromium): every model (`2D_versatile_fluo`
  untiled, 2 × 2 tiled and non-multiple-of-16 crop; `2D_versatile_he` 37 nuclei; `2D_paper_dsb2018`
  121 nuclei; `3D_demo` 30 nuclei untiled and 4-tile 3D seam mosaic) reproduces Python StarDist
  0.9.1's label image SHA-256 byte for byte and skimage regionprops' CSV table.

## Data and licences

- Models: `2D_versatile_fluo`, `2D_versatile_he`, `2D_paper_dsb2018` and `3D_demo` from
  [stardist-models](https://github.com/stardist/stardist-models) v0.1, BSD-3-Clause, Copyright (c)
  2018-2024 Uwe Schmidt, Martin Weigert. All four ONNX files are pinned in
  `models/stardist.manifest.json`.
- Examples:
  - `dsb2018-nuclei-2d.tif` (512 × 512, 16-bit): StarDist's `test_image_nuclei_2d` from the 2018
    Data Science Bowl (BBBC038v1, CC0 1.0; Caicedo et al., Nature Methods 2019).
  - `skin-he-nuclei-2d.png` (512 × 512, RGB): 512 × 512 crop of `skimage.data.skin()` (human
    epidermis and dermis H&E histology by Kilbad on Wikimedia Commons, public domain / CC0-1.0;
    distributed in scikit-image, van der Walt et al., PeerJ 2014).
  - `stardist-demo-nuclei-3d.tif` (57 × 61 × 31, 16-bit): StarDist's synthetic
    `test_image_nuclei_3d` (BSD-3-Clause). `3D_demo` is a demonstration model trained on synthetic
    3D nuclei and does not establish accuracy on real tissue.
- Ported code: StarDist and CSBDeep are BSD-3-Clause; `clipper-lib` is the Boost Software
  License. This app is BSD-3-Clause (`LICENSE`); `NOTICE` holds the attributions and the Boost
  licence, and the build ships both at the app's root.

## Not in this version

- Custom user-trained StarDist models.
- WebGPU inference; the CPU build takes a few seconds on the examples.
- An OME-Zarr label layer; only the label TIFF is written.
- Cellpose, for whole-cell segmentation, is future work.
