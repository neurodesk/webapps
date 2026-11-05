# Spot detection

Detects diffraction-limited spots (smFISH mRNAs, puncta) in one 2D image or 3D stack in the
browser, with the spot detector of [Big-FISH](https://github.com/fish-quant/big-fish)
(FISH-quant v2; Imbert et al., RNA 2022, doi:10.1261/rna.079073.121) ported to JavaScript.

## Method

`src/bigfish.js` and `src/subpixel.js` port Big-FISH 0.6.2 (BSD-3-Clause, `LICENSE`, `NOTICE`):

1. `get_object_radius_pixel`: sigma = spot radius / voxel size per axis (nm).
2. `stack.log_filter`: SciPy `gaussian_laplace` (truncate 4, mode reflect) on the image scaled
   to [0, 1], negated and clipped at 0, cast back to the input's integer type. The kernel,
   the correlation order and the casts follow SciPy, NumPy and scikit-image.
3. `local_maximum_detection`: voxels equal to the maximum over a window of
   2 ceil(sigma) + 1 voxels per axis.
4. Automatic threshold (`_get_candidate_thresholds`, `_get_spot_counts`,
   `get_breaking_point`): log spot count against candidate threshold, smoothed over 5, and
   its elbow. A threshold typed in Advanced settings replaces it, and the elbow is then not
   searched for, as in Big-FISH.
5. `spots_thresholding` with duplicates removed: connected maxima above the threshold
   (full connectivity) become their centroid, truncated to integers.
6. `fit_subpixel`: each spot's neighbourhood (sqrt(ndim) times the radius) is fitted with
   Big-FISH's pixel-integrated Gaussian from the same start, with the same background bound
   and the same rule that keeps the integer coordinate on an axis whose fitted centre leaves
   the crop.

Per-cell counts follow Big-FISH's `multistack`: a spot belongs to the label under its integer
voxel; a 2D label image applies to every plane. Label 0 in the counts table is the spots outside
every cell. "2D maximum projection" runs the same detector on `stack.maximum_projection`.

Not included: dense-region decomposition (`decompose_dense`) and cluster detection.

## Inputs and outputs

One one-channel TIFF (uint8, uint16, float32 or float64), one page per z plane, read with the
shared TIFF module (geotiff.js). The voxel size comes from ImageJ or OME-TIFF metadata when present, else from the
form; the automation operation does the same for a voxel size its parameters leave out (300 and
103 nm when the file has none). Optional cell labels: an integer TIFF of one y × x plane or of the
image's size. 3D labels need detection in the 3D stack: the app refuses them with "2D maximum
projection" before it starts.

The detector holds about 21 (uint8), 39 (uint16, float32) or 67 (float64) bytes per input voxel
(`WORKING_BYTES` in `src/config.js`). A run that would need more than 4 GiB, what 64-bit Chromium
gives one tab's arrays, is refused before it starts: a 100-plane 1024 × 1024 uint16 stack needs
3.8 GiB and runs; 120 such planes do not.

- `<name>_spots.csv`: `spot_id`, sub-pixel `z, y, x` (voxels), integer `z_px, y_px, x_px`, raw
  `intensity` at that voxel, `log_response` (the filtered value Big-FISH thresholds) and, with
  labels, `cell_id`.
- `<name>_spots.nii.gz`: a ring around each spot in its plane, for viewing over the image, with
  the voxel size in millimetres as NIfTI records it.
- `<name>_cell_counts.csv` with labels: `cell_id, spots, area_px`, and a `0` row for spots outside.

## Example

`experiment_1_smfish_fov_1.tif` (23 × 650 × 500, uint16, 300 × 103 × 103 nm) from the
[Big-FISH examples](https://github.com/fish-quant/big-fish-examples) release, BSD 3-Clause,
unchanged, and `experiment_1_cell_label.tif`, its two cells segmented by
`validation/make_cell_labels.py` with Big-FISH's classical segmentation (the last cell of
notebook 4) from that stack and the same release's DAPI stack,
<https://github.com/fish-quant/big-fish-examples/releases/download/data/experiment_1_dapi_fov_1.tif>. Both are pinned at `neurodeskorg/webapps@baa8f47d`, `spot-detection/example/`.

## Validation

`validation/bigfish_reference.py` ran Big-FISH 0.6.2 (NumPy 1.21.6, SciPy 1.7.3,
scikit-image 0.18.3, Python 3.9, Linux x86-64) on three synthetic images, which
`validation/synthetic.py` and `src/synthetic.js` both generate with integer arithmetic only,
and on the example, and recorded `validation/reference.json`.

| Case | Threshold | Spots | LoG image | Spot set | Sub-pixel within 0.001 px |
| --- | --- | --- | --- | --- | --- |
| synthetic 3D (12 × 64 × 72) | 10 | 38 | identical | identical | 38/38 (max 1.5e-6) |
| synthetic 2D (96 × 80) | 11 | 28 | identical | identical | 28/28 |
| synthetic 2D fine (64 × 64) | 30 | 12 | identical | identical | 12/12 |
| example 3D | 355 | 771 | identical | identical | 756/771 (max 9.0e-4) |
| example maximum projection | 203 | 656 | identical | identical | 653/656 (max 2.2e-4) |

Per-cell counts are identical on both example cases. The example's 771 spots at threshold 355
are also the numbers Big-FISH's own tutorial notebook reports.

- `test/bigfish.test.js` checks the synthetic cases in Node (no data needed).
- `e2e/smoke.spec.js` runs the hosted example in Chromium and checks every integer spot,
  intensity and cell count against `reference.json`, for the stack and its projection.
- `node validation/compare.mjs DIR` checks both example cases in Node from local copies.

## Divergences from Big-FISH

- **Sub-pixel fit.** Big-FISH fits with SciPy's trust-region-reflective `curve_fit`, whose model
  is evaluated in float32 (the grid is float32 and NumPy 1.21 keeps float64 scalars from
  promoting it) with a finite-difference Jacobian. The port fits the same model in float64 with
  its analytic Jacobian by Levenberg-Marquardt, with curve_fit's default tolerances and its
  evaluation limit (100 per parameter; past it the integer coordinate is kept, as Big-FISH does
  on its RuntimeError). Where the fit is well posed the two agree within 0.001 px. On 15 of the
  771 example spots it is not: 12 lie on the last plane (z = 22), where the crop is cut off, and
  in all 15 Big-FISH's own result rejects the fit on some axis or moves the centre by more than a
  pixel. Both optimizers stop at arbitrary points there; the port more often keeps the integer
  coordinate.
- **exp.** The Gaussian kernel uses a correctly rounded exp. Big-FISH gets glibc's, which on this
  machine differed from the correctly rounded value on 89 of 107 500 test arguments (0.08 %), and
  macOS or Windows libm differ again; one ulp in a kernel tap can move a filtered voxel by one
  grey level. On every recorded case the filtered image is identical.
- **Percentile.** The candidate thresholds use NumPy 1.21's percentile formula, the version the
  reference ran; NumPy 1.22 changed the interpolation arithmetic.
