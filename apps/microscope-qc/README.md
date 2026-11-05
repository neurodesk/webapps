# Microscope QC

Light-microscope quality control in the browser, with the definitions of MetroloJ_QC and
QUAREP-LiMi (Faklaris et al. 2022, J Cell Biol 221:e202107093):

- **PSF from beads**: lateral and axial FWHM of sub-resolution beads in one z-stack, against the
  theoretical resolution for the microscope type, NA, wavelength and immersion index.
- **Field illumination**: uniformity, field uniformity and centering accuracy of one image of a
  uniform fluorescent slide, with intensity profiles and an iso-intensity map.

Input is one single-channel TIFF or OME-TIFF, read with the shared
`@neurodesk/webapp-components/file-io/tiff`. Pixel size, z step, NA, immersion refractive index,
wavelengths and acquisition mode are taken from OME-XML (`Pixels`, `Objective`,
`ObjectiveSettings`, `Channel`) or ImageJ metadata when present; every value can be typed in, and
a TIFF without metadata runs on typed values alone. Multi-channel files, OME files with several
images and time series are refused before decoding. All numerics are pure JavaScript in
`src/core`, run in one module worker that is terminated on cancel.

## Method

The code is a clean implementation of the published definitions. MetroloJ_QC's repository has no
licence file, so none of its code is copied; it ran only as an external reference (below).

**Beads.** Maxima of the z maximum-intensity projection whose topographic prominence (height above
the level where they join a brighter maximum, 8-connected) is at least the threshold, by default
10 robust background SDs (1.4826 × MAD) of the projection. A bead is rejected when its crop box
(default ±4 theoretical lateral FWHMs) leaves the image, another maximum lies in it, a voxel in it
is saturated, or the focus is the first or last plane. The centre is the brightest pixel of the
box's projection and the brightest plane there, MetroloJ_QC's default "maximum intensity"
centring. The x and y profiles run through that voxel across the box, the z profile through the
whole stack; each is fitted by Levenberg–Marquardt with ImageJ's Gaussian
`y = a + (b − a)·exp(−(x − c)²/(2d²))` from MetroloJ_QC's starting values, and
FWHM = 2√(2 ln 2)·d. Fit quality is ImageJ's adjusted R². A bead is listed but left out of the
summary if any axis fit is below the minimum R² (0.95, the QUAREP-LiMi recommendation). The
lateral asymmetry ratio is min(FWHMx, FWHMy)/max(FWHMx, FWHMy).

**Theory.** The FWHM formulas MetroloJ_QC applies, from the Methods of Faklaris et al. 2022 for
widefield, confocal and spinning disk and from Zipfel, Williams & Webb 2003 (Nat Biotechnol
21:1369, doi:10.1038/nbt899) for multiphoton:
widefield 0.51 λem/NA and 1.77 n λem/NA²; point-scanning confocal 0.51 λex/NA and
0.88 λex/(n − √(n² − NA²)); spinning disk 0.51 λem/NA and λem/(n − √(n² − NA²)); multiphoton
0.377 λex/NA (0.383 λex/NA^0.91 above NA 0.7) and 0.626 λex/(n − √(n² − NA²)). A mean FWHM above
1.5 × theory is flagged. The widefield axial formula is paraxial, so at high NA it overestimates
the axial FWHM and the flag is lenient. Measured widths include the bead's size; the axial width is in stage
coordinates, with no focal-shift correction for a refractive-index mismatch.

**Field illumination.** ImageJ 1's `GaussianBlur` with σ = 2 px (ported from the public-domain
source, including its kernel edge correction, float32 arithmetic and rounding back to the integer
type), then uniformity = 100·min/max; field uniformity = 100 − 100·SD/max, the population SD of
the four corners and four edge midpoints; iso-intensity zones floor(I/max·100/step)·step for a whole-number step; and
centering accuracy = 100 − 200·d/√(w² + h²), d the distance from the centroid of the top zone
(90–100 % by default) to (⌊w/2⌋, ⌊h/2⌋). Positions of the minimum and maximum are the last such
pixel in raster order, as in MetroloJ_QC.

Not in v1: 3D Gaussian fits, PSFj's per-bead 2D fits and field maps of FWHM, co-alignment,
multi-channel stacks, a command line.

## Validation

`test/fixtures/metroloj-reference.json` is recorded by `validation/reference.mjs`, which runs
`validation/metroloj_reference.groovy` in Fiji (Docker
`fiji/fiji@sha256:6ca1105db5b8f4234baab107f7b833ba0f5da64770ef48dddabb954990d68120`, ImageJ 1.53q,
headless) with the MetroloJ_QC 1.3.1.2 jar (sha256
`aae4a65782a2844fcece29c951f3d58f9e8e7ea742385afdf04a177f01f262d2`); the script checks both. MetroloJ_QC's own report generators need its dialog, so the
script calls its pieces directly: ImageJ's `MaximumFinder` (strict, edges kept) on the
`ZProjector` maximum projection; for each bead the app measured, the crop, centring, `getLine`
profiles and `Slicer` z reslice of MetroloJ_QC's `PSFprofiler`, fitted by MetroloJ_QC's
`CurveFitterPlus`; and for the field, ImageJ's `GaussianBlur` with the field-illumination
formulas restated in Groovy. Those formulas come from the same author as the app, so the field
metrics' independent check is a unit test that pins the formulas to a published MetroloJ_QC
report: the University of Eastern Finland's LSM800 field illumination report
(https://sites.uef.fi/cell-and-tissue-imaging-unit/wp-content/uploads/sites/168/2026/07/LSM800_Illumination_2026-06-12_Illumination.pdf),
whose border intensities, extremes and reference-zone centroid give its uniformity (45.2 %),
field uniformity (86.8 %) and centering accuracy (94.2 %).

```sh
node validation/reference.mjs <dir with both example files> MetroloJ_QC-1.3.1.2.jar <scratch dir>
```

Measured (unit tests in `test/`, browser tests in `e2e/`):

| Check | Result |
| --- | --- |
| Gaussian profiles of known σ, noise-free | σ, centre, baseline exact to 1e-9 |
| 200 noisy, quantised profiles | worst σ error < 1 %, mean < 0.2 % |
| 3D Gaussian beads of known σ (4 beads, noise, rounding) | every FWHM within 1 % on x, y and z |
| Example: bead centres (50 measured beads) | identical to MetroloJ_QC's centring |
| Example: FWHM of the 134 profiles with R² ≥ 0.8 | within 1.0e-6 relative of `CurveFitterPlus` (R² within 1e-6) |
| Example: maxima | 63 in both; 58 at the same pixel, 5 one pixel apart on flat-topped peaks |
| Small synthetic stack | maxima, centres and FWHMs equal ImageJ/MetroloJ_QC |
| Field blur, 61 × 47 uint16 | every pixel equal to ImageJ's `GaussianBlur` |
| Field metrics, small image and the 640 × 480 example | equal to the ImageJ blur with the Groovy formulas to 1e-9 |
| Field formulas on a published MetroloJ_QC report (UEF LSM800) | uniformity 45.2, field uniformity 86.8, centering 94.2 % |

Below R² ≈ 0.8 the two fitters can end in different local minima of a profile that is not a
Gaussian (most often a weak bead's z profile); those beads are below the summary threshold either
way.

On the bead example with the defaults (±9 px box, prominence 29.7), 63 maxima give 50 measured
beads, 5 of which pass R² ≥ 0.95 on all three axes: FWHM x 0.383 ± 0.016 µm, y 0.384 ± 0.024 µm
(1.36 × the 0.282 µm theory) and z 2.27 ± 0.06 µm (2.21 × the 1.03 µm theory, flagged). The axial
excess is measured, not explained: the stack is in stage coordinates of an air objective focused
into mounting medium, and the axial profiles are asymmetric.

## Examples

- `evos-beads`: a 512 × 512 × 81 crop of
  `NA095/Z-Stack 13-08-2021 01.21.20/stack/stack.tif` from Miora, Senftleben & Abrahamsson,
  *Experimental validation of numerical point spread function calculation including aberration
  estimation*, Zenodo, https://doi.org/10.5281/zenodo.10522322, CC BY 4.0. 100 nm TetraSpeck
  beads, EVOS M5000, Olympus 40×/0.95 air, GFP cube. Pixels unchanged; an OME-XML header records
  the EVOS metadata (pixel size, z step, NA, refractive index) and the GFP cube's band centres
  (470/525 nm). The dataset copy carries a README with the notice.
- `synthetic-field`: **Synthetic**. An off-centre Gaussian illumination profile with Poisson
  noise, a stand-in because no openly licensed field-illumination image of a uniform slide was
  found (the MetroloJ_QC paper's dataset carries no licence). It shows the metrics, not a real
  microscope.

Both are written by `validation/make_examples.py` and pinned at
`neurodeskorg/webapps@2609ad8a2e76afd5c8442660d4267250947fae06` under `microscope-qc/example/`.

## Licence

MIT (`LICENSE`). The Gaussian blur in `src/core/field.js` is a port of ImageJ 1's
`GaussianBlur` (public domain).
