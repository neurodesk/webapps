# Structure Tensor

Fibre orientation analysis of microscopy images with the structure tensor, the method of
OrientationJ (Rezakhaniha et al. 2012, doi:10.1007/s10237-011-0325-z; Püspöki et al. 2016,
doi:10.1007/978-3-319-28549-8_3). It takes a 2D image or a 3D stack and returns orientation,
coherency and energy maps, a colour map, the orientation distribution and a summary. Everything
runs on the CPU in the browser.

## Method

`src/tensor.js` is a pure module with float64 sums. It runs in a module worker in the page and
under Node in the tests. It was written from the papers. OrientationJ is GPL-3.0, so its code is
used only as an external validation reference.

- Gradients are Gaussian derivatives with standard deviation σ. Their outer products are averaged
  by a Gaussian window with standard deviation ρ. Both are given in pixels of x. The kernels
  follow `scipy.ndimage.gaussian_filter`: sampled and normalised, truncated at 4σ, with `reflect`
  borders.
- **2D.** Orientation is `0.5·atan2(2Jxy, Jyy − Jxx)`, in degrees counterclockwise from +x with
  rows pointing down, in (−90°, 90°]. These are OrientationJ's formula and convention. Coherency
  is `(λmax − λmin)/(λmax + λmin)`, and energy is the trace. The colour survey uses
  hue = orientation, saturation = coherency and brightness = the image, through
  `java.awt.Color.HSBtoRGB`'s arithmetic.
- **3D.** The tensor is a 3 × 3 matrix, decomposed by cyclic Jacobi rotations. The fibre
  direction is the eigenvector of the smallest eigenvalue. It is reported as azimuth (the 2D
  convention applied to its xy projection) and elevation (signed angle from the xy plane towards
  +z). Fibre coherency, defined by this app, is `(λ2 − λ3)/(λ2 + λ3)`, which is 1 for tubes and 0 for sheets and
  isotropic texture. The direction map is `|v|·coherency` as RGB, as in DTI colour maps.
- **Voxel size.** σ and ρ are scaled to each axis by the voxel size, so the filters are isotropic
  in space, and gradients are expressed per x pixel. The app refuses any setting where σ is under
  one voxel along an axis. A thinner sampled derivative kernel loses gain: σ = 0.5 voxel along z
  gave a 7° error on a synthetic lattice (`test/tensor.test.js`).
- **Distribution.** Pixels with coherency ≥ *min coherency* and energy ≥ *min energy* × the
  largest energy are counted, as in OrientationJ's Distribution, in 1° bins. 3D stacks get
  azimuth and elevation bins. The dominant direction comes from the tensor summed over the whole
  image, as in OrientationJ's Dominant Direction.

## Inputs and outputs

- TIFF, grey or RGB, single page or stack, read with the shared TIFF module. Colour channels are
  averaged, as in ImageJ's RGB to 8-bit conversion. Voxel size comes from the resolution tags and
  ImageJ's `spacing=`, or from an OME-XML description's `PhysicalSize*` attributes, which also set
  the number of slices. Without a length unit (ImageJ's `unit=pixel`, or a plain TIFF's
  resolution tags) the declared sizes keep their ratios, with x as 1 pixel. Hyperstacks with
  several channels or time points (ImageJ or OME), OME-TIFFs whose planes are in other files and
  TIFFs with thumbnail or pyramid pages in the main page chain are refused.
- NIfTI, 3D. Its angles are measured on the voxel grid with the second index pointing down, as
  for TIFF rows. A NIfTI displayed with +y up therefore shows mirrored angles.
- PNG and JPEG, and several 2D slices of one size, which are stacked in name order with cubic
  voxels.
- Inputs are limited to 2²³ voxels, because 3D runs hold up to nine float64 working arrays. The
  limit is checked from the file headers (all slices together) before any voxels are decoded.
- Samples must be finite: an image with a NaN or an infinity is refused when it is loaded.
- Maps are written as float32 TIFF stacks with an ImageJ description for TIFF and raster input,
  and as gzipped NIfTI for NIfTI input. The 3D direction map is RGB TIFF or RGB24 NIfTI. The
  fibre vectors are always a 3-frame NIfTI. The colour survey is a PNG. The distribution is a CSV
  file (`quantity,bin_low_deg,bin_high_deg,count,fraction`), and the summary is JSON.

## Examples

- **SHG collagen, human dermis.** PSHG-TISS (Hristu et al. 2022, Scientific Data 9:376,
  doi:10.1038/s41597-022-01477-1, data at osf.io/udtqp, CC BY 4.0), `skin_12`, unstained
  reticular dermis, forward SHG. The example is the uint16 sum of the nine polarisations from 0°
  to 160°. SHG brightness depends on the angle between a fibre and the polarisation, so a single
  polarisation would bias the distribution. `validation/make-example.py` builds it. The file is
  512 × 512, 0.5 MB, and is pinned on `neurodeskorg/webapps` at
  `09b7e0aa259ccfda6c5044a5a640e91f231ab49d`, with a README carrying the CC BY 4.0 notice.
- **Synthetic 3D fibres.** A 64 × 64 × 32 float32 stack written by
  `scripts/make-synthetic-example.mjs`. It holds two cosine lattices of cylinders: azimuth 30°,
  elevation 0° for x < 32, and azimuth −45°, elevation 40° beyond. It is a software check, not
  tissue.

## Validation

- `validation/scipy-reference.py` computes the same tensor with `scipy.ndimage` and
  `numpy.linalg.eigh` (numpy 2.2.6, scipy 1.15.3). It writes `validation/reference.json`.
  - On the gratings at seven angles and three 3D lattices, including one with 1 × 1 × 2 voxels,
    the Node tests agree with it: orientation within 1e-9°, coherency within 1e-12 and energy
    within 1e-10 relative. Away from the borders the true angle is recovered within 0.01°.
  - On the SHG example (`node validation/check-example.mjs <tif>`), the maps agree within
    6e-14° and 4e-16 at 64 points. The 180-bin histogram is identical, with 114 578 pixels
    counted. The dominant direction is 86.518° with coherency 0.648.
  - The browser test downloads the float32 maps and holds them to the same reference at float32
    precision.
- `validation/orientationj/` holds the cross-check against OrientationJ 2.2.0. It ran in
  ImageJ 1.54f headless under Xvfb in `eclipse-temurin:21-jre`; jar hashes are in
  `results.json`.
  - On 128 × 128 gratings, OrientationJ also recovers each angle to about 0.001° (largest error
    0.001045°), with the same sign convention.
  - On the SHG example with tensor = 3 and its Gaussian gradient, its orientation differs from
    this app's σ 1, ρ 3 by a median of 1.7° (95th percentile 9.6°) on coherent pixels.
    Coherency differs by a median of 0.024. Its energy has a different scale, and correlates at
    0.965.
  - Most of the difference is the window's width. OrientationJ's recursive Gaussian makes nine passes
    of a filter whose pole is set so that three passes have standard deviation `tensor`, so its
    window is √3 · `tensor` wide: 5.2 px at tensor = 3 (the impulse response, computed
    numerically). `fit-window.py` searched σ and ρ: σ 1, ρ 5 matches OrientationJ with a median
    difference of 0.08° (95th percentile 0.55°, coherency 0.001).

## Deliberate differences from OrientationJ

- The gradient is a Gaussian derivative at a chosen σ. OrientationJ's default is a cubic spline,
  and its Gaussian option fixes σ = 1.
- The tensor window is a sampled Gaussian (scipy) whose ρ is its standard deviation.
  OrientationJ's `tensor` setting gives a window √3 times wider, so ρ ≈ 1.7 × `tensor` here
  reproduces an OrientationJ analysis.
- Energy is the unscaled trace.
- The 3D analysis, fibre coherency and direction map are not part of OrientationJ, which is 2D.
- Laplacian-of-Gaussian prefiltering, Harris corners, vector fields and k-means clustering are not
  implemented.

## Development

```sh
pnpm --filter structure-tensor test       # numerics, settings, TIFF round trip
pnpm --filter structure-tensor test:e2e   # production build in Chromium
python3 -I validation/scipy-reference.py <example.tif> validation/reference.json
```
