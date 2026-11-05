# Histology to MRI

Registers 2D histology sections to an MRI volume in the browser, on the CPU, with Greedy's NMI
metric (`@neurodesk/greedy`, its committed single-threaded WebAssembly) in one module worker per
run (`src/worker.js`); cancelling terminates the worker.

1. **Inputs**: one 3D NIfTI MRI and one or more sections: RGB or greyscale TIFF
   (`@neurodesk/webapp-components/file-io/tiff`, `readTiffImage`), PNG or JPEG
   (`file-io/raster-image`). Several sections are taken in file-name order, `Slices between
   sections` apart. NaN or infinite MRI voxels are refused.
2. **Plane** (`src/core/plane.js`): the slice along a voxel axis, optionally offset along its
   normal and tilted about its two in-plane axes, sampled trilinearly on a square grid of the
   slice's smallest in-plane voxel size.
3. **Section contrast** (`src/core/colour.js`): brightness (Rec. 709 luminance), inverted when
   the image border is brighter than its mean so that brightfield and dark-field slides both
   have a dark background, or a colour-deconvolution stain channel (haematoxylin, eosin, DAB;
   Ruifrok & Johnston 2001, their published vectors with scikit-image's `rgb2hed` scaling).
4. **Scale and start** (`src/core/register.js`): Otsu tissue masks of the section and the MRI
   plane; unless the pixel size is given, the section's pixel size is the one that makes both
   tissue areas equal (it absorbs shrinkage). The section is block-averaged to about the plane's
   spacing and placed with its tissue centroid on the MRI's.
5. **Orientation, rigid, affine**: a Greedy rigid registration from each of the eight rotations
   and flips (or the one chosen), the best NMI over the whole plane wins; then a Greedy affine.
6. **Plane search** (optional): every offset (±2 slices in half-slice steps) and tilt pair (±4° in
   1° steps) is scored by NMI against the section moved by the current affine; the affine is
   refitted on the best plane and the search repeats until the best plane repeats. A plane is
   kept only if its refitted affine scores better over the whole plane.
7. **Deformable**: Greedy's stationary-velocity registration with NMI, `0x0x200` iterations.
   A warp that lowers NMI over the plane is dropped and the report says so.

Greedy is 3D. Each section is registered in its plane's local frame: the moving image is the
section repeated on three slices 1 m apart (no gradient across the plane) and every linear
result keeps only its in-plane terms (`matrix.js`, `inPlane`). The linear stages take the MRI
plane as a single slice. For the deformable stage Greedy's NMI gradient would sample the slice
beyond a single-slice image, and that across-plane term dominates its normalised update (a
measured 0.1 mm maximum warp), so the fixed image is the plane repeated on three slices with
a mask on the middle one, at full resolution only: with three slices there is no coarser level
that keeps the mask.

Outputs per section: the section warped onto the plane (RGBA NIfTI, alpha 0 off tissue, up to
4× finer than the MRI), the MRI on the plane, the section contrast as registered, the affine
(`.mat`, Greedy's RAS text) and warp (`.nii.gz`, Greedy's LPS displacement field), all in world
coordinates, and a JSON report (plane, orientation, pixel size, NMI at each stage, settings).
`greedy -d 3 -rf <name>_mri_plane.nii.gz -rm <name>_section.nii.gz out.nii.gz -r <name>_warp.nii.gz <name>_affine.mat`
reproduces the registered section (`test/outputs.test.js` runs this with Greedy's reslice).
All sections are also drawn into the MRI grid as one RGBA NIfTI: every voxel the plane passes
through takes the warped section's colour.

## Validation

`node validation/run.mjs` (Greedy's single-threaded build in Node, the bytes the browser
runs) writes `validation/results.json`:

- **Synthetic**: the example MRI's slice 50 deformed by a known similarity with anisotropic
  shrinkage and a smooth warp of up to 1.2 mm, re-coloured as an H&E brightfield slide
  (`validation/synthetic.js`). At 361 landmarks on a 6-voxel grid inside tissue the mean error
  is 0.35 MRI voxels (median 0.32, maximum 1.73) after the deformable stage and 0.49 after the
  affine. `test/register.test.js` repeats this on a phantom slice and requires a mean below
  one voxel, and checks the orientation search (a flipped, rotated section) and the plane search
  (it finds a section cut one slice off and tilted 2°).
- **Example**: six landmarks placed by eye, independently on the MRI and on the section
  (`validation/example-landmarks.json`, one marked low confidence). The mean error is 1.8 mm
  (3.0 voxels of 0.6 mm; 0.96–2.37 mm). The landmarks' own placement error and the difference
  between the section and any MRI plane (cutting and mounting distortion) are both in this
  number; how they split is not measured.

The colour deconvolution equals scikit-image 0.24 `rgb2hed` to 1e-9 (`test/colour.test.js`).

## Example

AHEAD brain 152017 (Alkemade et al. 2022, *Science Advances* 8:eabj7892, CC BY 4.0): thionin
section 150 of the frontal stains (`Ahead_brain_152017_Thio_polaroid_150.tif`,
doi:10.21942/uva.16843039) block-averaged 4 × 4 to 84.7 µm pixels and scaled to 8-bit RGB, and
the quantitative R1 map in blockface space (doi:10.21942/uva.14260064) cropped to its anterior
405 slices and block-averaged to 0.6 mm isotropic. The section lies near slice 50 along k.
Both files and a README with the modifications are on Hugging Face under
`neurodeskorg/webapps/histo2mri/example/`.

## Limits

- One plane per section; tears, folds and missing pieces are not modelled.
- The automatic pixel size assumes the MRI plane and the section show the same tissue (an
  ex vivo brain or block); for an in vivo head MRI give the section's pixel size.
- The deformable stage runs at the plane's full resolution only, so it corrects deformations of
  a few voxels; larger ones must be taken up by the affine.
- The MRI must be NIfTI; DICOM series are not converted.
