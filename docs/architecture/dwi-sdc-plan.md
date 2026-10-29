# SDC port and validation plan

Plan, 19 October 2026, for step 7 of the [diffusion design](dwi-microstructure-design.md): susceptibility distortion correction (`sdc`) with SyN-SDC, the fieldmap-less method of sdcflows. It follows the form of the HMC plan (PR [#486](https://github.com/neurodesk/webapps/pull/486)). PR #486 is not merged yet, so this plan links the PR. After #486 merges, a follow-up changes the link to `dwi-hmc-plan.md`. The native reference runs of section 6.1 are done (#461; `sdc/reference/` and `sdc/prior/` on the Hugging Face dataset, pinned by `exes/dwi/sdc/validation/`). Nothing else is implemented yet.

Sources that this plan read, with the commit of each:

| Source | Version | Commit or digest |
| --- | --- | --- |
| sdcflows (Apache-2.0) | 2.17.1 | tag commit `96a4e1425923d180569dcccd6ca688e9fa54874d`; PyPI wheel SHA-256 `00a9f29b5410a1a79b4111845d9201d517260ffd3f07828e8fc69de92007d14b` |
| niworkflows, nipype, scikit-learn | 1.15.3, 1.12.0, 1.9.1 | the versions that `uv pip install sdcflows==2.17.1 scikit-learn` resolved on 19 October 2026 (with nitransforms 25.1.0, nibabel 5.4.2, numpy 2.5.4, scipy 1.18.1, scikit-image 0.26.0, templateflow 25.1.2) |
| QSIPrep (BSD-3-Clause) | 26.1.1 | tag commit `371b537ad890a390dd7c2e2fa60e4231ffbc364e`; container `sha256:b7d91d9755fd97647632a1f900238425239cd834c97e9866b20af39e224d383a` |
| fMRIPrep | 25.2.7 | tag commit `5433029c0f907c59a98c5cf41fd2c3c6fbd5ce14` |
| ANTs | 2.6.2 | `52bc0ab588102682587303d31c720de94e6ef6c1`, the commit of the repository's WebAssembly builds |
| TemplateFlow `tpl-MNI152NLin2009cAsym` | - | `15d7c02160f79f5218d2545b4febebeecc11531d` |

A citation `file:line` refers to sdcflows 2.17.1 unless it names another source. `syn.py` is `sdcflows/workflows/fit/syn.py`. A path that starts with a repository folder (`packages/`, `exes/`) refers to this repository.

Section 9 records the decisions (Q57-Q71). The maintainer accepted them on 20 October 2026. Decisions 1-11 of [#460](https://github.com/neurodesk/webapps/issues/460) are Q57-Q67, in that order. Q68-Q71 are new questions that the source reading and the review found. The fixed decisions Q51 (keep the b0 volumes), Q52 (MindGrab mask of the mean b0, or an uploaded mask) and Q53 (`antsRegistration --float 1`, no double build) apply.

## 1. Corrections to the issue's facts

Most facts in #460 agree with the source. These do not:

- **The EPI is not regridded before SyN.** `find_zooms` and `zooms_epi` exist (`syn.py:225-226,668-677`). `find_zooms` gets its inputs at `syn.py:295-296`, and `zooms_epi` gets its inputs at `syn.py:304,307`. No node reads the output of `zooms_epi`, so it is dead code.
  - The SyN fixed grid is `sampling_ref` (`syn.py:504,562,591`).
  - `GenerateSamplingReference` with `keep_native=True` keeps the EPI field of view. It uses the voxel size of the anatomical image (niworkflows `interfaces/nibabel.py:381-387,598-607`).
  - On ds005134 sub-01 that is 0.8 mm, a 289 × 289 × 171 grid (14.3 M voxels). Section 7 shows why this is the main memory risk. The port uses a 2 mm grid (Q68).
- **The deformation is not restricted to the PE axis only.** `_warp_dir` gives weight 1.0 to the PE axis and 0.1 to the two other axes (`syn.py:620-623`). The rendered argv is `--restrict-deformation 0.1x1.0x0.1` for `j-` on a RAS fixed grid. QSIPrep's SyN uses `[0, 1, 0]` (QSIPrep `workflows/fieldmap/syn.py:214`).
- **The third SyN parameter is in voxels, not mm.** `_mm2vox` divides the total-field variance by the PE voxel size of the fixed grid (`syn.py:626-642`). At 0.8 mm the stages are `SyN[0.8, 6.0, 12.5]` and `SyN[0.8, 2.0, 0.625]`, not `10.0` and `0.5`. On the 2 mm grid of Q68 they are `5.0` and `0.25`.
- **`ImageMath Laplacian` reads one number, not two.** ANTs reads sigma and the normalize flag from the same argument (`ImageMath_Templates.hxx:9188-9206`, `argct` is not incremented between them). With `op2 '1.5 1'` sigma is 1.5 and normalize is `stoi("1.5") = 1`. The trailing `1` has no effect.
- **QSIPrep 26.1.1 has no `--use-syn-sdc`.** It was removed (QSIPrep `docs/upgrading.rst:58-60`, `docs/changes.md:29`). Its replacement does not run sdcflows (Q57).

## 2. The SyN-SDC pipeline in sdcflows 2.17.1

sdcflows has two workflows: `init_syn_preprocessing_wf` (`syn.py:342-597`) and `init_syn_sdc_wf` (`syn.py:46-339`). The sdcflows command line wires only the second (`fieldmaps.py:501-504`). fMRIPrep connects both (fMRIPrep `workflows/base.py:792-817`). The reference run (Q57) must do the same in a short driver script.

### 2.1 Preprocessing (`init_syn_preprocessing_wf`)

| Step | sdcflows | Port |
| --- | --- | --- |
| EPI reference | niworkflows `init_epi_reference_wf` (`syn.py:470-473,552`): `RobustAverage`, `IntensityClip` 35/99.98, `N4BiasFieldCorrection -d 3 --convergence [ 50x50x50x50x50, 1e-07 ] --shrink-factor 4`, `IntensityClip` 2/100, `StructuralReference` (niworkflows `workflows/epi/refmap.py:145-181`) | Mean of the b0 volumes (the `gradients` b0 rule), then the same clip, N4 and clip. `RobustAverage` motion-corrects a 4D input with AFNI `3dvolreg` (`mc_method` default `'AFNI'`, niworkflows `interfaces/images.py:214-219,318`). A 3D input passes unchanged (`images.py:250-254`), so AFNI does not run. The reference run gets the port's 3D mean b0. FreeSurfer is still necessary: for one image, `StructuralReference` replaces the `mri_robust_template` command with `echo` (`interfaces/freesurfer.py:81-84`), but nipype first checks that `mri_robust_template` is on `PATH` (nipype `interfaces/base/core.py:750-758`). Also, `epi_merge` sets `transform_outputs=True` (niworkflows `workflows/epi/refmap.py:178`), so `_list_outputs` runs FreeSurfer `lta_convert` (`freesurfer.py:91-98`). Section 6.1 gives the environment. |
| Deoblique | `Deoblique` when obliquity ≥ 0.5° (`interfaces/utils.py:48,459-490`) | Port `_deoblique` as is. Its new origin subtracts `(shape − 1) × 0.5` in voxel units (`utils.py:480`); copy it. ds005134 is not oblique (obliquity 0). |
| EPI brain mask | `BrainExtraction` (`syn.py:474,555`; `utils/tools.py:153-215`, random walker) | MindGrab of the mean b0 (Q52, Q61) |
| Anatomical mask | input `mask_anat` (fMRIPrep gives the smriprep T1w mask) | MindGrab of the T1w (Q61) |
| Anatomical image | `ApplyMask`, `IntensityClip` 0/99.8, `DenoiseImage -n Gaussian -s 1` (`syn.py:480-482,548-554`) | The same. `DenoiseImage` is an ANTs entry point (section 3). |
| EPI to anat | `antsRegistration` from `affine.json` (`syn.py:484-492`): Rigid then Affine, Mattes 32 bins, center-of-mass start, fixed mask = dilated anat mask, moving masks `[NULL, dilated EPI mask]` (`syn.py:494-499,557-561`) | Same argv, `--float 1`, fixed seed |
| Mask dilation | `BinaryDilation`, ball of radius 3 voxels (`interfaces/brainmask.py:68,114-131`) | Port (deterministic) |
| Sampling grid | `GenerateSamplingReference(fixed=EPI, moving=anat)` (`syn.py:504,562,591`) | Same rule: EPI field of view, anat voxel size rounded to 0.001 mm (niworkflows `nibabel.py:598-607`). The port uses the 2 mm debug path (Q68). |
| Anat to EPI | `antsApplyTransforms` Linear (image) and MultiLabel (mask), inverse of the EPI-to-anat affine (`syn.py:452-468,563-568`) | Same argv |
| Prior | `fmap_atlas.nii.gz` through `[epi2anat⁻¹, std2anat_xfm, fmap_atlas_2_MNI152NLin2009cAsym_affine.mat]`, Linear, then `Binarize` with `data > 3` (`syn.py:506-538`; niworkflows `nibabel.py:115`). Without a prior, the anat mask takes its place (`syn.py:540-542`). | See Q59 for `std2anat_xfm` |
| Debug path | With `debug=True` the anat is regridded to 2 mm before `sampling_ref` (`syn.py:575-585`). fMRIPrep sets `debug` from `--sloppy` (fMRIPrep `workflows/base.py:792-798`). | Used by the port (Q68) |

### 2.2 Registration (`init_syn_sdc_wf`)

- Readout: `GetReadoutTime` takes `PhaseEncodingDirection` from the metadata with no default (`interfaces/epi.py:58-74`). The docstring says "anterior-posterior PE is assumed" (`syn.py:60-61`), but the code raises a `KeyError`.
- EPI channel: `IntensityClip` 35/99.9 (`syn.py:198`). Laplacian channels: `ImageMath Laplacian 1.5 1` on the anat and on the clipped EPI (`syn.py:188-191,198-201`), then `_norm_lap`: subtract the median, scale the positive part by its 99.8th percentile and the negative part by its 0.2th percentile, clip to [-1, 1] (`syn.py:719-742`).
- Masks per stage (nipype renders one `--masks` per stage, nipype `interfaces/ants/registration.py:1179-1191`):
  - fixed: stage 1 the anat mask, stage 2 the prior mask (`syn.py:217-222,288-289`);
  - moving: stage 1 `NULL`, stage 2 the union of the EPI mask and the dilated anat mask resampled to the EPI grid with MultiLabel (`syn.py:181-185,208-216,298,301,308-309`; `brainmask.py:134-149`).
- Schedule (`data/sd_syn.json:1-23`): two SyN stages, each with two Mattes metrics of 48 bins (image pair, Laplacian pair). Weights `[0.9, 0.1]` then `[0.8, 0.2]`; iterations `200x100` then `10`; convergence `1e-06`/window 5 then `1e-08`/window 2; shrink `1x1` then `1`; smoothing `2x0` then `0` vox; Random 0.8 in stage 1 and no sampling in stage 2; histogram matching on; winsorize `[0.001, 0.998]`; Linear interpolation; collapsed output. There is no `float` key, so native ANTs runs in double. The `laplacian_weight` option (`syn.py:242-250`, capped at 0.5 by `syn.py:43`) is not used by fMRIPrep.
- `sd_syn_sloppy.json` differs only in iterations (`20x10` then `2`, line 9: 10 times fewer in stage 1, 5 times fewer in stage 2) and `"verbose": true` (line 20). `sloppy=True` also sets `zooms_min=4.0` for the B-spline fit (`syn.py:228,278-279`).
- The rendered native argv for ds005134 sub-01 (`j-`, fixed grid 0.8 mm RAS; nipype 1.12.0):

```text
antsRegistration --collapse-output-transforms 1 --dimensionality 3 --initialize-transforms-per-stage 0 --interpolation Linear --output fmap_syn
  --transform SyN[ 0.8, 6.0, 12.499999813735489 ]
  --metric Mattes[ anat_ref, epi_clip, 0.9, 48, Random, 0.8 ] --metric Mattes[ anat_lap, epi_lap, 0.1, 48, Random, 0.8 ]
  --convergence [ 200x100, 1e-06, 5 ] --smoothing-sigmas 2.0x0.0vox --shrink-factors 1x1 --use-histogram-matching 1
  --restrict-deformation 0.1x1.0x0.1 --masks [ anat_mask, NULL ]
  --transform SyN[ 0.8, 2.0, 0.6249999906867744 ]
  --metric Mattes[ anat_ref, epi_clip, 0.8, 48 ] --metric Mattes[ anat_lap, epi_lap, 0.2, 48 ]
  --convergence [ 10, 1e-08, 2 ] --smoothing-sigmas 0.0vox --shrink-factors 1 --use-histogram-matching 1
  --restrict-deformation 0.1x1.0x0.1 --masks [ sd_prior, epi_umask ]
  --winsorize-image-intensities [ 0.001, 0.998 ] --write-composite-transform 0
```

On the 2 mm grid of Q68 (the port and the reference) the stages are `SyN[ 0.8, 6.0, 5.0 ]` and `SyN[ 0.8, 2.0, 0.25 ]`; `render_argv.py` records the exact strings.

- The seed: sdcflows passes no `--random-seed`. ANTs then reads `ANTS_RANDOM_SEED`, else seed 0, which does not re-seed the sampler (`antsRegistrationTemplateHeader.h:61-77`; `itkantsRegistrationHelper.hxx:1975,2002-2005`; `antsRegistration.cxx:506-515`). The reference sets `ANTS_RANDOM_SEED`. The port always passes `--random-seed`.

### 2.3 Field map (`init_syn_sdc_wf`, continued)

- `DisplacementsField2Fieldmap` takes the first forward transform (`syn.py:256,320-323`; `interfaces/fmap.py:160-208`, `demean=False`). `disp_to_fmap` (`transform.py:624-674`): flip x and y (ITK LPS to RAS), map mm to EPI voxels with the inverse EPI affine, keep the PE axis, divide by `TotalReadoutTime`, negative for a `-` direction. The output keeps the grid of the displacement field (the `sampling_ref` grid: 0.8 mm in stock sdcflows, 2 mm in the port, Q68).
- `zooms_field`: `antsApplyTransforms --interpolation BSpline --transform identity -u float` to the EPI reference grid (`syn.py:261-264,297,324`).
- `BSplineApprox` (`interfaces/bspline.py:128-283`; `syn.py:271-279,326`):
  - control spacing `DEFAULT_HF_ZOOMS_MM` = (16, 16, 10) mm (`bspline.py:51`); grid shape `extent // spacing + 3`, centred on the image (`bspline.py:540-565`). On the 116 × 116 × 69 EPI grid that is 17 × 17 × 16 = 4624 coefficients;
  - `recenter=False`, `extrapolate=True`, `zooms_min=1.0` (no resize at 2 mm) (`bspline.py:65-84,149-160`);
  - no mask: the `in_mask` connection is commented out (`syn.py:327-329`), so every voxel is a sample (`bspline.py:168-172`);
  - cubic tensor-product weights from `scipy.interpolate.BSpline` on knots `-3 … n+2`, support `|d| < 2` (`transform.py:677-766`);
  - `sklearn.linear_model.Ridge(alpha=1e-4, fit_intercept=False)` on a sparse float32 matrix, up to three fits while `max|coef| ≥ 1e4` (`bspline.py:203-216`). For sparse input without intercept, scikit-learn 1.9.1 selects `sparse_cg` (`linear_model/_ridge.py:867-878`): scipy conjugate gradient on `XᵀX + αI` with `rtol=1e-4` (`_ridge.py:86-156`). The fit has 0.93 M samples and 4624 features, so it runs the linear branch (`_ridge.py:138-145`), not the kernel branch.
- `ApplyCoeffsField(jacobian=False)` evaluates the coefficients on the EPI reference grid and unwarps the reference (`syn.py:258,330-336`; `bspline.py:388-438`). The workflow output `fmap` is this evaluated field in Hz (`transform.py:335-353`). It is the field that the gate compares (Q66).
- Unwarp (`transform.py:71-117,369-549`): the voxel shift is `field × TotalReadoutTime`. The data are reoriented by `ensure_positive_cosines`, but the sign comes from the axis codes of the **original** image, which `ensure_positive_cosines` returns (`utils/tools.py:144-150`): `flip = (axcodes[pe_axis] in 'LPI') XOR (PE direction ends with '-')` (`transform.py:494-499`). A port that uses the RAS codes after the reorientation never applies the orientation flip. Resampling is `scipy.ndimage.map_coordinates`, order 3, prefilter on, mode `constant`, value 0 (`transform.py:99-107,378-382`); negative values become 0 (`transform.py:544-545`). Head-motion transforms are ignored (`transform.py:509-524`), which agrees with "each app resamples once". The Jacobian factor `1 + ∂vsm/∂pe` uses `numpy.gradient` (`transform.py:114-115`).

## 3. Registration engine and ANTs entry points (Q58)

Use the ANTs 52bc0ab kernel. Do not change `packages/registration`: its `--apply` has only linear and nearest (`packages/registration/src/apply.cxx:28-31`), its wasm is SHA-256-pinned, and SYNcro parity depends on it.

| Entry point | Need | Where |
| --- | --- | --- |
| `antsRegistration` with full argv, `--float 1`, `--random-seed` | SyN (two metrics per stage, `--restrict-deformation`, `--masks` per stage) and the EPI-to-anat affine | `packages/hmc-registration` `run(argv)` (#444). All options are in ANTs already (`antsRegistration.cxx:252,480`); no ANTs change. |
| `antsApplyTransforms` | Linear, MultiLabel, BSpline; inverse flags; a chain of three transforms with an `.h5` composite | Add the real ANTs CLI (`antsApplyTransforms.cxx:1101-1103`) to `packages/hmc-registration`. [#445](https://github.com/neurodesk/webapps/issues/445) adds BSpline and sinc interpolators to the custom `--apply`, but `--apply` does not cover MultiLabel or transform chains. Decided (Q58): #462 adds the full `antsApplyTransforms` entry, and `--apply` stays for HMC as #445 defines it. The two share the ITK interpolators, so the wasm holds one copy of that code. If #445 is not merged first, #462 adds the full CLI and #445 can use it in place of a new `--apply` interpolator (Q58). |
| `ImageMath ... Laplacian` | sigma 1.5, normalize to [0, 1] | A small entry that copies `LaplacianImage` (`ImageMath_Templates.hxx:9183-9230`, `LaplacianRecursiveGaussianImageFilter` and `RescaleIntensityImageFilter`). The full `ImageMath` (15 000 lines of templates) would make the wasm much larger. Its argv parsing is copied (section 1). |
| `DenoiseImage` | `-n Gaussian -s 1` | ANTs `DenoiseImage.cxx` in `packages/hmc-registration` |
| `N4BiasFieldCorrection` | EPI reference: `--convergence [ 50x50x50x50x50, 1e-07 ] --shrink-factor 4` | `packages/n4` (PR [#380](https://github.com/neurodesk/webapps/pull/380)): its `main.cxx` passes argv to ANTs unchanged, so only a JavaScript argv builder is new. The wasm bytes do not change. |

Decided (Q58): `sdc` shares `packages/hmc-registration` with `hmc` (one ANTs module, one toolchain, one build). The module keeps the rules of #444 for `antsRegistration`: refuse its argv without `--float 1`, always pass `--random-seed`. All entries use one ITK thread (as `packages/registration/src/main.cxx:15-16`).

Native reference ANTs: the local native build of 52bc0ab has only `antsRegistration` and `antsApplyTransforms` (`BUILD_ALL_ANTS_APPS=OFF`). #461 adds `ImageMath`, `DenoiseImage` and `N4BiasFieldCorrection` targets at the same commit.

The other rendered argv (nipype 1.12.0):

```text
antsRegistration --collapse-output-transforms 1 --dimensionality 3 --initial-moving-transform [ anat_denoised, epi_ref, 1 ] --initialize-transforms-per-stage 0 --interpolation Linear --output transform
  --transform Rigid[ 2.0 ] --metric Mattes[ anat_denoised, epi_ref, 1, 32, Regular, 1 ] --convergence [ 1000x0, 1e-06, 10 ] --smoothing-sigmas 6.0x0.0mm --shrink-factors 4x1 --use-histogram-matching 1 --masks [ anat_dil, NULL ]
  --transform Affine[ 1.0 ] --metric Mattes[ anat_denoised, epi_ref, 1, 32, Random, 0.4 ] --convergence [ 250x100, 1e-07, 5 ] --smoothing-sigmas 2.0x1.0vox --shrink-factors 2x1 --use-histogram-matching 1 --masks [ anat_dil, epi_dil ]
  --winsorize-image-intensities [ 0.001, 0.998 ] --write-composite-transform 0
DenoiseImage -i anat_clip -n Gaussian -o anat_clip_noise_corrected -s 1
ImageMath 3 anat_ref_maths Laplacian anat_ref 1.5 1
antsApplyTransforms --default-value 0 --float 0 --input fmap_atlas --interpolation Linear --output fmap_atlas_trans --reference-image sampling_ref --transform [ epi2anat0GenericAffine.mat, 1 ] --transform std2anat_xfm --transform fmap_atlas_2_MNI152NLin2009cAsym_affine.mat
antsApplyTransforms --default-value 0 --float 0 --input anat_mask --interpolation MultiLabel --output anat_mask_trans --reference-image sampling_ref --transform [ epi2anat0GenericAffine.mat, 1 ]
antsApplyTransforms --default-value 0 --float 0 --input anat_dil --interpolation MultiLabel --output anat_dil_trans --reference-image epi_mask --transform identity
antsApplyTransforms -u float --default-value 0 --float 0 --input field_Hz --interpolation BSpline --output field_Hz_trans --reference-image epi_ref --transform identity
```

#461 adds the script that rendered these lines (`render_argv.py`, nipype with dummy files) to the reference folder. Apart from the grid values of Q68, the WASM argv adds `--float 1` and `--random-seed` to `antsRegistration` only. `antsApplyTransforms --float 0` stays: it is a resampling precision flag, not the registration precision of Q53.

## 4. Deterministic ports and numerical risks

Crate `exes/dwi/sdc` and `sdc-wasm` (#463). The WebAssembly takes and returns Float32 voxel arrays; NIfTI reading stays in the shared JavaScript.

| Function | Source | Risk |
| --- | --- | --- |
| `disp_to_fmap` | `transform.py:624-674` | The input is ANTs' displacement in LPS; the inverse affine handles axis order and flips. Test all six PE directions on LAS and RAS grids. |
| B-spline grid and weights | `bspline.py:540-565`, `transform.py:677-766` | `//` on float extent; the knot window `[1:-1]` of the scipy basis; the `\|d\| < 2` support. |
| Ridge solve | `bspline.py:203-216`, sklearn `_ridge.py:86-156,867-878` (linear branch `138-145`) | `sparse_cg` stops at `rtol=1e-4`, in float32. An exact solve differs from it. To meet #463's 1e-4 Hz median, port scipy's `cg` (x₀ = 0, the same residual test, f32 operators). Also compute the exact solve in tests to know the CG error. |
| Field evaluation | `transform.py:335-353` | Coefficients are written as float32 before the evaluation (`bspline.py:227`); copy that rounding. |
| Unwarp of the DWI series | `transform.py:71-117,369-549` | Port scipy `spline_filter` and `map_coordinates` (order 3) with mode `constant`. Read scipy 1.18.1 for the prefilter boundary mode that `constant` uses before the port. `numpy.gradient` uses central differences inside and first-order differences at the edges (`edge_order=1`). |
| `_advanced_clip` | niworkflows `nibabel.py:667-726` | The same algorithm as NiFreeze's `advanced_clip` in the HMC plan (median filter with `ball(3)`, percentiles of positive values, `round(255x)`). Share one implementation with the `hmc` crate. |
| `_norm_lap` | `syn.py:719-742` | numpy percentile (linear) and median on float64 data |
| Dilation, union, binarize | `brainmask.py:114-149`, niworkflows `nibabel.py:115` | `skimage.morphology.ball(3)` footprint; `> 3` is strict |
| `_deoblique`, `_warp_dir`, `_mm2vox`, `_adjust_zooms` | `utils.py:459-490`, `syn.py:600-677` | Header arithmetic only; `nb.aff2axcodes` with `('RR','AA','SS')` ignores the sign. `_adjust_zooms` is dead code (section 1); do not port it. |

The repository rule for NIfTI I/O applies (design, Code layout). The JavaScript pipeline (#464) runs ANTs, MindGrab and the crate in order.

## 5. Inputs and outputs (Q62, Q63)

Inputs: the DWI series (NIfTI + bval + bvec + JSON, DICOM, or a BIDS folder through the shared reader), one T1w, and optional masks (EPI and T1w).

Pinned assets (Q60): `fmap_atlas.nii.gz`, `fmap_atlas_2_MNI152NLin2009cAsym_affine.mat` and the MNI152NLin2009cAsym 1 mm T1w and brain mask for the affine of Q59. They come from `sdc/prior/` on the Hugging Face dataset, through `models/sdc.manifest.json` and the offline asset inventory. The "no prior" option needs none of them.

Outputs (BIDS derivatives; the names go through the shared module of [#413](https://github.com/neurodesk/webapps/issues/413)):

| File | Content |
| --- | --- |
| `*_desc-sdc_dwi.nii.gz` | the corrected DWI series, all volumes, b0 kept (Q51); one cubic resampling with the Jacobian factor (Q63) |
| `*_desc-sdc_dwi.bval`, `.bvec` | unchanged copies. SyN deforms all three axes, but `disp_to_fmap` keeps only the PE component (section 2.3), so the unwarp moves voxels along the PE axis only. sdcflows does not rotate b-vectors. |
| `*_desc-sdc_dwi.json` | the input sidecar plus a provenance block (tool versions, seed, PE direction, `TotalReadoutTime`, mask source) |
| `*_desc-preproc_fieldmap.nii.gz` + `.json` | the field in Hz on the EPI grid, `Units: "Hz"`, as sdcflows names it (`workflows/outputs.py:186-198`) |
| `*_desc-coeff_fieldmap.nii.gz` | the B-spline coefficients (`outputs.py:244-256,273-289`), for the later joint resampling |
| `*_from-orig_to-sdc_mode-image_xfm.nii.gz` | the displacement field in ITK format (`fmap_to_disp`, `transform.py:575-621`) |
| `*_desc-brain_mask.nii.gz` | the EPI mask that was used |

## 6. Reference runs and gates

### 6.1 Reference tool (Q57)

Use native sdcflows 2.17.1. Do not use QSIPrep 26.1.1:

- QSIPrep removed `--use-syn-sdc`. The replacement is `--sdc-fieldmapless-method syn --sdc-anat-reference invt1w` (QSIPrep `docs/upgrading.rst:58-60`). It runs QSIPrep's own SyN workflow (QSIPrep `workflows/fieldmap/base.py:476-514`, `workflows/fieldmap/syn.py:76-260`). QSIPrep does not depend on sdcflows (`pyproject.toml:34` pins niworkflows only).
- That workflow differs from sdcflows 2.17.1 in every important point (QSIPrep paths):
  - the target is an inverted T1w (`syn.py:185`);
  - `data/susceptibility_syn.json:1-23` has Mattes 56 bins, then CC radius 5, `"float": true` and `SyN[0.8, 2, 2]`, with no Laplacian channel;
  - the restriction is `[0, 1, 0]` in voxel axes (`syn.py:214`);
  - the atlas threshold is 2 (`syn.py:76`);
  - the atlas is a different file: `mni_lps_fmap_atlas.nii.gz`, LPS 193 × 229 × 193, SHA-256 `7fb31f35…` (sdcflows has `72b8d2cc…`);
  - there is no B-spline field fit;
  - the PE is `j` when the metadata has none (`syn.py:145-149`).
- Docker Hub `nipreps/sdcflows` stops at 2.10.0 (checked 19 October 2026). fMRIPrep 25.2.7 pins `sdcflows ~= 2.15.2` (fMRIPrep `pyproject.toml:37`). fMRIPrep `master` requires `sdcflows >= 2.17.1` (`pyproject.toml:40`), and `ghcr.io/nipreps/fmriprep` publishes a `master` tag. This plan did not pull that image, so its sdcflows version is not known. It is a moving tag, but a digest of it can pin the environment (Q57).

The reference is a Python 3.12 environment with sdcflows 2.17.1 from PyPI (wheel SHA-256 above), recorded with `uv pip freeze`. Native ANTs 52bc0ab is on `PATH`, as for the HMC M0 runs. The freeze file, the wheel hash and the ANTs commit pin it.

FreeSurfer is also necessary (section 2.1). `mri_robust_template` must be on `PATH`, but it does not run, so a stub script is sufficient. `lta_convert` runs once and must work. #461 pins the FreeSurfer version that supplies it. The alternative is a driver that replaces `epi_merge` with an identity node; the README then lists that change.

A driver script connects `init_syn_preprocessing_wf` and `init_syn_sdc_wf` as fMRIPrep does (fMRIPrep `workflows/base.py:792-817`) and makes these changes, which the README lists:

- `in_epis` is the port's 3D mean b0 (section 2.1);
- the output of node `epi_brain` is replaced with the MindGrab mask of the mean b0 (Q52); `mask_anat` is the MindGrab mask of the T1w (Q61);
- `std2anat_xfm` is the transform of Q59;
- `ANTS_RANDOM_SEED` is set, and `ITK_GLOBAL_DEFAULT_NUMBER_OF_THREADS=1`, `OMP_NUM_THREADS=1`;
- the work directory is kept.

Runs on ds005134 sub-01. The full brain is the gate input (Q67). The slab is the example input (Q64).

| Input | Run | Purpose |
| --- | --- | --- |
| full brain, 2 mm grid (`init_syn_preprocessing_wf(debug=True)`, Q68) | double, seed 1234 | the reference |
| full brain, 2 mm grid | double, seeds 1235 and 1236 | the seed spread (three pairs) |
| full brain, 2 mm grid | `--float 1`, seed 1234 (driver sets `syn.inputs.float = True` and the same for `epi2anat`) | the native analogue of the WASM, as Q53 measured for HMC |
| full brain, 0.8 mm grid (stock) | double, seeds 1234, 1235 and 1236; `--float 1`, seed 1234 | Q68: the field difference between the stock grid and the 2 mm grid, against the 0.8 mm seed spread; the peak memory of `--float 1` |
| full brain, 2 mm grid | double, seed 1234, each prior variant of Q59 | Q59 |
| full brain, 2 mm grid | double, seed 1234, `sloppy=True` | Q69 (information only) |
| slab with the full T1w (Q64), 2 mm grid | double, seeds 1234, 1235 and 1236; `--float 1`, seed 1234 | the slab test of section 6.2 (M5, #465) |

Keep for each run:

- the argv of every ANTs call;
- the mean b0, both masks, the clipped and denoised anat, `sampling_ref`, and the anat and mask in EPI space;
- both Laplacian maps after `_norm_lap`, the warped prior and its mask, and the moving-mask union;
- the displacement field, the field in Hz before and after `BSplineApprox`, the coefficients and the corrected EPI reference;
- the wall time and the peak memory.

#461 also unwarps the DWI series with `ApplyCoeffsField(jacobian=True)` from the kept coefficients, so the port's resampling has a reference.

Folder: `sdc/reference/` on the Hugging Face dataset, with `README.md`, `index.json` and `SHA256SUMS` in the form of `hmc/reference/`, uploaded in one commit ([#374](https://github.com/neurodesk/webapps/issues/374)).

### 6.2 Gates

Deterministic parts (fixed tolerances; these stay):

- `disp_to_fmap` on the reference displacement field: median absolute difference ≤ 1e-4 Hz in the EPI mask (#463).
- `BSplineApprox` on the reference Hz field: coefficients and evaluated field to 1e-4 Hz median, and the maximum reported (#463).
- Unwarp of the DWI series from the reference coefficients: relative difference ≤ 1e-5 of the 99th percentile in brain, maximum reported.
- `_advanced_clip`, `_norm_lap`, dilation, union, binarize, `_deoblique`: equal to the Python output (masks voxel for voxel; images to 1e-6 relative).

Registration (WASM, `--float 1`). First replay the kept inputs of the double seed-1234 run, then run end to end. The field `f` is the workflow output `fmap` (section 2.3), in Hz, on the EPI grid. `M` is the MindGrab mask of the mean b0. The native runs are the 2 mm runs of section 6.1, so the WASM and the reference use the same grid. The rule (Q66, accepted):

- `spread = max over the pairs (a, b) of {1234, 1235, 1236} of median_M |f_native(a) − f_native(b)|`.
- `d = median_M |f_wasm(1234) − f_native(1234)|`.
- The WASM run passes when `d ≤ max(spread, 0.05 Hz)` **and** `d < 0.5 Hz`.
  - The floor of 0.05 Hz is necessary because only stage 1 samples at random, and convergence can stop a stage early. Thus the measured spread can be almost zero.
  - The design's start value, 0.5 Hz, stays as a cap. A large native spread cannot make the gate looser than the design.
  - The uncapped threshold `max(spread, 0.05 Hz)` never decreases as the spread increases. The effective gate stays capped by `d < 0.5 Hz`, even when the spread exceeds 0.5 Hz.
  - This agrees with #462, which asks for "< 0.5 Hz and the seed-spread rule".
- Also report the 95th percentile of the same differences, the native `--float 1` against double, and the difference of the pre-B-spline Hz field (more sensitive to the registration).
- Report-only: the field against ds005134's GRE field map (`fmap/sub-01_run-001_phasediff`, magnitude 1 and 2), resampled to the EPI grid. This is an independent measure, not the reference of the port.

Measured by #461 (`sdc/reference/` at dataset commit `8520dbca`, `README.md` there; median_M, p95_M in Hz):

| Quantity | median | p95 |
| --- | ---: | ---: |
| spread, end to end (three seeds, 2 mm, double) | 2.710 | 8.233 |
| native `--float 1` vs double, seed 1234, end to end | 0.437 | 1.920 |
| spread, SyN only (replays on the kept seed-1234 inputs) | 1.375 | 5.603 |
| native `--float 1` vs double, seed 1234, SyN only | 0.656 | 3.165 |
| the same seed twice (end to end and SyN only) | 0 (byte-identical) | 0 |
| report-only: reference `fmap` vs the GRE field map | 11.00 (Pearson r 0.663) | 35.08 |

- The spread is larger than the cap, so the effective gate is `d < 0.5 Hz`.
- The end-to-end spread also holds the `epi2anat` affine: the seed drives its Random 0.4 sampling, and between seeds it moves the mask voxels by 0.16-0.29 mm (median). The SyN-only replays fix it.
- **Risk:** the native `--float 1` run differs from the native double run by 0.656 Hz in the SyN-only replay, the input set of the first gate of #462. That is above the 0.5 Hz cap. A WASM `--float 1` run is likely to differ by about as much. This measurement does not change Q66; the maintainer decides if #462 needs a different cap for the replay.

Measured by #462 on the 1.2 mm grid (29 October 2026). The maintainer chose 1.2 mm and kept the cap (section 9, Q68). The reference is the native double seed-1234 run on that grid (`sdc/reference/grid-q68/` at dataset commit `e773666d`). `packages/hmc-registration/validation/sdc-gate/` runs every replay through the pinned drivers and computes each number with the pinned `compare_fields.py`. The native builds are ANTs 52bc0ab on ITK 5.4.3 with the reference's flags (gcc 11.4, `-O3 -march=corei7`); WASM is the hmc-registration kernel in Node 24. In the end-to-end WASM runs the kernel runs `antsRegistration`, and native builds run `antsApplyTransforms` and the Laplacian; the kernel writes the same voxels for those calls. The precision variants change only ITK's Mattes metric, through build-tree copies of its header and `.hxx` (`mattes-pdf-double.cmake` there):

- stock: the committed kernel (SHA-256 `53779fcd…`), `--float 1`;
- pdf64: `PDFValueType = double`, so the joint and marginal PDFs, their sums and the metric value accumulate in double; images, fields and transforms stay float;
- deriv64: pdf64, and the derivative of a transform with global support (the `epi2anat` affine) also accumulates in double. SyN's dense field has local support, so its replays are those of pdf64.

| Run, seed 1234, against native double | `fmap` median | p95 | max | `epi2anat` shift |
| --- | ---: | ---: | ---: | ---: |
| SyN only: native double (this build) | 0.0001 | 0.0004 | 0.0006 | - |
| SyN only: native double, `-march=native` (FMA) | 0.0002 | 0.0005 | 0.0010 | - |
| SyN only: stock, WASM and native | 0.084 | 0.349 | 1.38 | - |
| SyN only: pdf64 (WASM and native) and deriv64 (native; the same warp) | 0.040 | 0.142 | 0.63 | - |
| end to end: stock, WASM | 0.538 | 1.83 | 5.27 | 0.040 mm |
| end to end: stock, native | 0.318 | 0.78 | 1.43 | 0.047 mm |
| end to end: pdf64, WASM | 0.102 | 0.32 | 1.12 | 0.004 mm |
| end to end: pdf64, native | 0.598 | 2.17 | 6.49 | 0.040 mm |
| end to end: deriv64, WASM | 0.031 | 0.13 | 0.74 | 0.003 mm |
| end to end: deriv64, native | 0.154 | 0.54 | 1.53 | 0.010 mm |

The `epi2anat` shift is the median distance, over the EPI brain mask, between the points that the run's affine and the double affine map; the double affine of this build, with or without FMA, is within 4e-5 mm of the pinned one. Native double SyN-only replays at seeds 1235 and 1236 give a spread of 0.995 Hz (pairs 0.995, 0.860 and 0.561 Hz), so the cap decides the SyN-only gate; these two replays are not on the dataset. The end-to-end double runs at seeds 1235 and 1236 on this grid were not run.

- The replays are exact. The native double replay writes the pinned double warp byte for byte (its `fmap` differs by 1e-4 Hz through the B-spline fit), and WASM writes the native `--float 1` warp and `fmap` byte for byte, for stock and for pdf64. With every ANTs program in the kernel (`antsApplyTransforms`, the Laplacian), the SyN-only `fmap` is the same file. A rounding-only change of the double run (FMA) moves the field before `BSplineApprox` by at most 1e-5 Hz, so the float differences above are precision, not run-to-run noise.
- SyN only, the committed kernel is at 0.084 Hz: under the cap and under the spread, so it passes the whole rule; pdf64 halves it to 0.040 Hz, under the 0.05 Hz floor. On the 2 mm grid the same replay was 0.656 Hz.
- End to end, the float `epi2anat` affine decides the result. In float it lands 0.04-0.05 mm from the double affine, and SyN turns that into 0.3-0.6 Hz: the same precision gives 0.318 Hz in the native build and 0.538 Hz in WASM, whose affine is the pinned native `--float 1` affine byte for byte (gcc 13). pdf64 does not reduce the affine error natively (0.040 mm, 0.598 Hz); its WASM affine happened to land 0.004 mm from double (0.102 Hz). deriv64 brings the affine to 0.010 mm from double natively and 0.003 mm in WASM, and the end-to-end field to 0.154 Hz natively and 0.031 Hz in WASM: under the cap in both builds, and in WASM under the 0.05 Hz floor.
- **So the committed kernel passes the SyN-only replay (0.084 Hz) and fails end to end (0.538 Hz) on the 1.2 mm grid.** With deriv64, both the SyN-only median of 0.040 Hz (the SyN warp of pdf64, which deriv64 leaves byte for byte unchanged natively) and the WASM end-to-end median of 0.031 Hz are below the cap, without `antsRegistration3DDouble`. The native end-to-end median of 0.154 Hz also meets the cap, but full native Q66 acceptance is undetermined because the end-to-end double seed spread was not measured. deriv64 is not in the committed kernel: it changes the registrations in this module that use the Mattes metric, so shipping it needs a decision (an SDC build of the kernel, or HMC validated with it; the recheck below gives HMC's results).

Rechecked on 29 October 2026 with dlmalloc, the allocator of #643 (`sdc-gate/results-dlmalloc.json`, main `f1ac9b2a`). `build-wasm.sh deriv64` now links dlmalloc too (`fd9ea784…`); on the rigid test pair it writes the same transform as the mimalloc deriv64 build above.

- **End to end, every program in WASM.** A fresh run at seed 1234 ran in WASM all ten of its calls to programs the kernel has: `epi2anat` and SyN, six `antsApplyTransforms` and two Laplacians. Only `DenoiseImage`, which the kernel lacks, ran natively, and it wrote the pinned `ref_anat` file byte for byte. The run started from an empty work directory, so no node came from nipype's cache; `check_calls.py` lists all eleven calls. The run gives d = 0.03106 Hz (p95 0.128, max 0.745) and an `epi2anat` shift of 0.0026 mm. Every compared output, from the `epi2anat` affine to `fmap`, is the same file as in the deriv64 run of the table, which had kept its `epi2anat` from the cache and run the other tools natively.
- **Q66 for WASM deriv64 at seed 1234:** d < 0.5 Hz, and d ≤ 0.05 Hz ≤ max(spread, 0.05 Hz) for any spread, so both conditions hold without the end-to-end double spread. Native deriv64 (0.154 Hz) still needs that spread for full Q66 acceptance; it was not measured.
- **HMC with deriv64.** NiFreeze's registrations (`exes/dwi/hmc/src/registration.rs`, the argv `packages/hmc` runs) use the `GC` metric, which deriv64 does not change. All 101 registrations of HMC's Q53 replay write the committed kernel's bytes. The accepted native-float gate passes all 540 world-centre cells; the reported QSIPrep-pivot comparison fails one cell (volume 52 tx), as with the committed kernel; and `q53_replay.rs` passes with its table unchanged. The package's own Mattes rigid test pair does change: 6 of its 35 tests fail, each at its first assertion, the native `--float 1` hash `NATIVE_MAT_SHA256` (deriv64 writes `e70a8ac1…`, as the native deriv64 build does). The known shift is still recovered (largest parameter change 0.0059). Fed the committed kernel's two registrations, deriv64's `AverageAffineTransform`, `--apply` and `AverageImages` write every remaining golden's native bytes.
- **Other users of the module.** BISON runs its FLAIR-to-T1 rigid in this kernel with the Mattes metric (`packages/bison/src/preprocess.js`, `rigidArguments`), so a shared deriv64 kernel would change that registration; open PR #642 moves it to Greedy. It was not measured here.

The idea is the same as Q53: the WASM result must be within the native repeat spread. The rule is different in two ways:

- Q53 uses one seed pair and compares per volume and per axis. Q66 takes the maximum over three pairs. That is closer to the shell-maximum alternative of the HMC plan, which is not accepted.
- The SHORELine repeat rule of the HMC plan (PR #486) is a pending decision, not an accepted rule. This plan does not use it as a precedent.

Q66 uses the median over the brain because a field map is one image, not 6 numbers per volume. A per-voxel spread rule would fail where the field is near zero.

CI:

- The gate tests of #462 and #464 are Node tests, not Playwright tests. The `@slow` tag of AGENTS.md does not apply to them.
- The full-brain gate runs in a native workflow job, as the `fida-reference` job in `lcmodel-native.yml` does. The job provisions the pinned `sdc/reference/` data and sets a require variable, so a missing input fails the test and does not skip it (#462). The job runs on pull requests that change `packages/sdc`, `packages/hmc-registration` or `exes/dwi/sdc`, nightly and on manual dispatch.
  - `.github/workflows/sdc-registration-gate.yml` is that job for the SyN-only replay on the 1.2 mm grid: it fetches the data with their SHA-256, replays SyN with the committed kernel through sdcflows, and requires `d < 0.5 Hz` (`gate.py --require`). The double replays at seeds 1235 and 1236 are not on the dataset, so the job does not evaluate the spread condition. The end-to-end run needs a native `DenoiseImage` and is not in CI. It runs on pull requests that change `packages/hmc-registration` or `exes/dwi/sdc`, nightly and on manual dispatch; `packages/sdc` joins when the pipeline of #464 runs in the gate.
- The slab e2e test of #465 is a Playwright test. It is untagged and runs on every pull request. It compares the app with the native slab runs of section 6.1, with report-only numbers.
- If a full-brain Playwright test is added later, AGENTS.md allows `@slow` only when an untagged test completes a run with the same model, method, option and kind of geometry. The maintainer decides then if the slab test satisfies that rule.

## 7. Runtime and memory (Q65)

Measured by #461 (21-22 October 2026) with native ANTs 52bc0ab on one thread, AMD Ryzen 9 9950X; `sdc/reference/README.md` has every run. Up to 17 runs shared the host's 32 logical cores, one thread each, so a wall time on an idle host can be shorter. "Max RSS" is the largest resident memory of one process (`/usr/bin/time -v`). The cgroup peak of a run also counts the page cache, so it is larger and is not used here.

| Grid | Voxels | SyN `antsRegistration` (double / `--float 1`) | Whole run (double / float) |
| --- | --- | --- | --- |
| 0.8 mm (stock, ds005134) | 289 × 289 × 171 = 14.3 M | 5242-5412 s, 13.10 GB / 4595 s, 6.97 GB | 5641-5807 s / 4973 s |
| 2 mm (debug path, the port's grid, Q68) | 116 × 116 × 69 = 0.93 M | 73-97 s, 0.96-0.98 GB / 60 s, 0.54 GB | 459-490 s / 320 s |
| slab, 2 mm (Q68) | 67 × 92 × 10 = 0.06 M | 6.5-7.2 s, 0.09 GB / 3.2 s, 0.07 GB | 77-80 s / 74 s |

- The 0.8 mm `--float 1` SyN alone had a max RSS of 6.97 GB. That is above the 3.5 GB limit of Q68 option (a), so the stock grid does not fit the 4 GiB wasm32 heap. The field difference test of Q68 reopens the decision (section 9, Q68), but memory alone excludes option (a).
- On the 2 mm grid SyN is not the longest step. `epi2anat` (the EPI-to-anat affine on the 0.8 mm T1w grid) took 190-314 s and 0.66 / 1.25 GB (float / double), and `DenoiseImage` of the 0.8 mm T1w took 27-30 s and 0.79 GB. These two steps work on the T1w grid, not on the SyN grid.
- The affine to MNI (Q59): `affine.json` with the 1 mm template brain fixed (193 × 229 × 193) and the T1w brain moving took 885 s and 1.37 GB in double on one thread. The estimate (under 1 min) was wrong: the Rigid stage runs up to 1000 iterations at shrink 4 and the Affine stage 100 iterations at full resolution. With the 0.8 mm T1w fixed (21.3 M voxels) it took 1847 s. The browser cost of this step, and of `epi2anat`, must be measured in #462 and #464.
- The template download is 13 844 613 bytes (T1w 13 685 075, brain mask 159 538); the atlas and its affine are 5 801 693 bytes (`sdc/prior/`).
- MindGrab (Node driver, CPU, 32 threads): 14-15 s and 2.75-3.08 GB for each call (mean b0, slab mean b0, T1w).
- The GRE field map (report-only): 11 s.
- The B-spline fit: 0.93 M × 4624 sparse matrix with 64 entries for each row, about 0.5 GB in CSR float32 with indices. It runs in the Rust crate. It was not measured alone: it runs in the Python driver process, whose max RSS was 1.70 GB in the 0.8 mm runs and 2.57 GB in the reference run, which also unwarped the 137-volume DWI series (25 s).
- Anchor kept for the WASM estimate: SYNcro's WASM affine + SyN at 1 mm (7.2 M voxels) took 186 s and grew a 3.16 GB heap (`packages/syncro/validation/README.md:33`). The WASM module has `MAXIMUM_MEMORY` 4 GiB (`packages/registration/CMakeLists.txt:35`; #444 copies it). The command line (#466) runs the same wasm32 module in Node, with the same limit.
- **Measured in WASM on the 1.2 mm grid (#462, 29 October 2026; the hmc-registration kernel in Node 24, one thread, AMD EPYC-Rome shared with other runs).** SyN (193 × 193 × 115 = 4.28 M voxels) grew the kernel's linear memory to its 4 GiB maximum (4 294 901 760 bytes), with the committed kernel and with pdf64 alike. The largest `_emscripten_resize_heap` target was 4 234 933 440 bytes (3.94 GiB) with both (`HMC_WASM_HEAP_TRACE=1`). This is a requested linear-memory size, not an individual allocation size or a peak live allocator footprint. The process's max RSS was 3.22-3.29 GB, against 2.20-2.21 GB for native `--float 1` SyN on the same host. SyN took 2761-2827 s (native 1963-2076 s). `epi2anat` on the 0.8 mm T1w grid grew the heap to 1.36 GB (max RSS 1.10 GB; native 0.66 GB) in 1041-1071 s (native 728-761 s).
  - **The observed linear-memory capacity exceeds the about 3.5 GB target of Q68.** The run completes in Node, but this does not establish that a browser worker can allocate the same capacity. The roughly 60 MB difference between the largest growth target and the resulting capacity is not measured free allocator space. Peak live allocations, fragmentation and browser-worker memory use remain unmeasured.
- **With dlmalloc (#643; 29 October 2026, `sdc-gate/results-dlmalloc.json`).** These are linear-memory capacity and process measures, not the allocator's live bytes or free space, and not the memory of a whole app.
  - Node: the deriv64 end-to-end run of section 6.2 grew linear memory to 732,823,552 bytes in `epi2anat` (max RSS 0.91 GB, 1088 s) and 2,258,173,952 bytes in SyN (max RSS 2.63 GB, 2940 s).
  - Chromium 156.0.8078.4 on this host: the module worker (`src/worker.js`, unchanged) ran the CI replay's SyN call with the committed kernel (`f09b3758…`) to the end, in the headless shell (2877 s) and in full Chromium (2891 s). Both grew linear memory in 19 steps to 2,155,610,112 bytes, as in Node, below the about 3.5 GB target, and both wrote the replay's warps byte for byte, so the call keeps d = 0.08392 Hz.
  - The renderer process that hosts the page and the worker had an RSS and VmHWM of 2,865,108 KiB (2.93 GB) when the reply reached the page (full Chromium; the headless shell's VmHWM was 2,704,624 KiB 1 s before it). Chromium's `measureUserAgentSpecificMemory()` attributed 2,173,447,653 bytes to the worker and 92,887,212 bytes, the received warps, to the page. The process peaks after the reply (3.10 GB in full Chromium, 3.56 GB in the headless shell) come from the harness hashing and uploading the warps.
  - Terminating the worker after the run returned its renderer to 139-207 MB within 2 s. A worker terminated 14 s into the call, its renderer at 1.25 GB, sent no reply; the renderers' summed RSS fell from 1.46 GB to 0.38 GB within 2 s (0.31 GB before the call), and a new worker ran the rigid test pair with native ANTs's bytes from a fresh 256 MiB kernel.
  - Not measured: other browsers and hosts, a device's own memory limit, the end-to-end call chain or the app in a browser.

## 8. Milestones

| Milestone | Issue | Content | Depends on |
| --- | --- | --- | --- |
| M0 | [#460](https://github.com/neurodesk/webapps/issues/460) | this plan | - |
| M1 | [#461](https://github.com/neurodesk/webapps/issues/461) | native ANTs targets; the driver; the runs of section 6.1, the slab runs included; seed spread; time and memory; the T1w for the example; upload to `sdc/reference/`; upload of the Q60 assets with their notices to `sdc/prior/` | #374 for the upload |
| M2 | [#463](https://github.com/neurodesk/webapps/issues/463) | `exes/dwi/sdc` and `sdc-wasm`: section 4 (the synthetic tests start after M0; the reference checks need M1). Its scope grows by the small numpy steps of section 4 (clip, Laplacian normalization, dilation, union, binarize, deoblique); the clip is shared with the `hmc` crate. | M0, M1 |
| M3 | [#462](https://github.com/neurodesk/webapps/issues/462) | the entry points of section 3 in `packages/hmc-registration`; the N4 argv builder; the replay gate of section 6.2 | [#444](https://github.com/neurodesk/webapps/issues/444), M1; [#445](https://github.com/neurodesk/webapps/issues/445) if it merges first (section 3) |
| M4 | [#464](https://github.com/neurodesk/webapps/issues/464) | `packages/sdc`: the pipeline in Node and in browser workers; refusals; outputs; `AbortSignal`; the `sdc/prior/` entries in `models/sdc.manifest.json` | M2, M3, [#410](https://github.com/neurodesk/webapps/issues/410), #413 |
| M5 | [#465](https://github.com/neurodesk/webapps/issues/465) | SyN-SDC in `apps/sdc`; example; offline assets for the prior and the example; e2e (headless CI uses an uploaded mask or MindGrab's CPU backend, [#394](https://github.com/neurodesk/webapps/issues/394)) | M4 |
| M6 | [#466](https://github.com/neurodesk/webapps/issues/466) | the `sdc` command line with `exes/node-cli` | M5 |
| Parallel | [#473](https://github.com/neurodesk/webapps/issues/473) | the reverse-PE app (PyHySCO, FD-Net), chosen by the decision document [#471](https://github.com/neurodesk/webapps/issues/471) | #471 |

`apps/sdc` is one app with a method selector. #465 and #473 both say "start from `pnpm new-app sdc`", and #473 says that SyN-SDC joins later. Decided (Q71): the first of #465 and #473 to start creates `apps/sdc` and `models/sdc.manifest.json`; the other adds its method to them. The two methods differ, and the app states it:

- **Licence.** #473 makes the app GPL-3.0 because of the PyHySCO solver. The SyN-SDC code (`packages/sdc`, `exes/dwi/sdc`) stays Apache-2.0, as #473 says.
- **Outputs.** Both write the field in Hz as a BIDS `fieldmap`. SyN-SDC also writes the corrected DWI series (section 5). #473 does not resample the DWI series. That is the joint hmc+sdc resampling of the design.
- **Inputs.** SyN-SDC needs a T1w and no reverse-PE data. The reverse-PE method needs AP and PA b0 volumes and no T1w.

This plan changes these acceptance criteria of the issues. The maintainer confirmed the changes on 20 October 2026, and the issues are updated:

- **#462:** "`--restrict-deformation` moves voxels only along the PE axis" becomes "the weights are `0.1x1.0x0.1` as sdcflows renders them" (section 1). The replay gate is the rule of section 6.2, which keeps "< 0.5 Hz" as a cap.
- **#461:** there is no sdcflows 2.17.1 container digest unless the fMRIPrep `master` image is used (Q57). The README states the freeze file, the wheel hash, the ANTs commit and the FreeSurfer version. "Add the T1w crop" becomes "add the full T1w (Q64)".
- **#464:** the acceptance names the slab for the gate. With Q67 the gate moves to the full brain, in a native workflow job (section 6.2). The slab test checks the pipeline against the native slab runs, with report-only numbers.
- **#465:** "the ds005134 slab with its T1w crop" becomes "the slab with the full T1w (Q64)". The issue creates `apps/sdc` only if #473 has not created it (Q71).
- **#473:** the issue adds its method to `apps/sdc` if #465 created it first (Q71).
- **#461, #462, #464, #465, #466:** the SyN grid is 2 mm (Q68). The maintainer changed it to 1.2 mm on 25 October 2026 (Q68).

[#495](https://github.com/neurodesk/webapps/issues/495) (registry niimath) does not affect `sdc`: no step uses niimath.

## 9. Decisions

1. **Q57. Which reference tool?**
   **Decided (20 October 2026):** native sdcflows 2.17.1 from PyPI with native ANTs 52bc0ab, driven by a script (section 6.1). QSIPrep 26.1.1 cannot be the reference: it has no `--use-syn-sdc`, and its replacement is a different SyN method. The freeze file, the wheel hash and the ANTs commit pin the environment. FreeSurfer supplies `lta_convert` (section 6.1). Seeds 1234, 1235 and 1236 in double; one `--float 1` run.
   The fMRIPrep `master` image is not used: its ANTs build is not 52bc0ab and its sdcflows version is not known.
2. **Q58. ANTs entry points and package.**
   **Decided (20 October 2026):** `sdc` shares `packages/hmc-registration` (#444). Add `antsApplyTransforms` (full CLI), a Laplacian entry copied from `LaplacianImage`, and `DenoiseImage`. Use `packages/n4` for N4 with a new argv builder. `--float 1` only (Q53); no change to `packages/registration`.
   The copied `LaplacianImage` replaces the full `ImageMath`. The full `antsApplyTransforms` entry sits next to the `--apply` of #445 (section 3).
3. **Q59. The anat-to-MNI152NLin2009cAsym transform for the prior.**
   SYNcro registers to a different template (FSL MNI152 1 mm, `packages/syncro/README.md:3,90`), so its transform cannot be used.
   **Decided (20 October 2026):** an affine-only registration of the MindGrab-masked T1w to the TemplateFlow `tpl-MNI152NLin2009cAsym_res-01_T1w` brain, with sdcflows' `affine.json` schedule, in WASM; the reference run gets the same transform from native ANTs. The prior is a coarse mask (`> 3` mm of average distortion), so an affine error of a few mm is likely small against the seed spread. Add an option "no prior" (`sd_prior=False`, the anat mask takes its place, `syn.py:540-542`).
   #461 measures three variants natively: a full SyN `std2anat_xfm` (as smriprep would give), the affine, and no prior. It reports the Dice of the prior masks and the field difference in brain. If the affine field differs from the SyN field by more than the seed spread, this decision is reopened.
   **Measured (#461, 22 October 2026):** Dice of the affine and the full SyN prior masks 0.911; `fmap` differs by 0.152 Hz (median_M; p95 2.73 Hz), less than the 2 mm seed spread (2.71 Hz). **The decision stays.** "No prior" differs from the affine prior by 2.75 Hz. The affine registered the T1w brain (moving) to the template brain (fixed); `std2anat_xfm` is its inverse (`sdc/reference/std2anat/affine/`).
4. **Q60. Licences and redistribution.**
   - `fmap_atlas.nii.gz` is in sdcflows `data/` (SHA-256 `72b8d2cc7ff3324f3bfaf52712bc191256e795bcff5ee168563b89e584aa40bb`).
     - It is the S2 File of Treiber et al. 2016, PLoS ONE 11(3): e0152472, [doi:10.1371/journal.pone.0152472.s002](https://doi.org/10.1371/journal.pone.0152472.s002). The downloaded file has SHA-256 `695bfdb19418309c9bdc4482e6e363067aa786322feb69751942985c7a707813`.
     - sdcflows set NaN to 0. The affine is the same, and the voxel data are equal after that change (checked 19 October 2026).
     - The article is under the Creative Commons Attribution License (CC BY 4.0 at PLOS ONE). PLOS applies the article licence to its supporting information. sdcflows cites the article (`docs/methods.rst:158,280-283`).
     - **It can be mirrored** to the Hugging Face dataset. The README gives the authors, the article, the DOI, the licence and "NaN set to 0".
   - `fmap_atlas_2_MNI152NLin2009cAsym_affine.mat` is part of sdcflows (Apache-2.0). It can be mirrored with the sdcflows licence notice.
   - MNI152NLin2009cAsym: TemplateFlow's `template_description.json` says "See LICENSE file"; the LICENSE (commit `15d7c02`) is the McConnell Brain Imaging Centre permission notice: use, copy, modify and distribute for any purpose without fee, with the copyright notice in all copies. **It can be mirrored** with that LICENSE file next to it. It is not the FSL MNI152 template, whose FSL terms are non-commercial.
   - ds005134 is CC0 (`dataset_description.json`).
   **Decided (20 October 2026):** the atlas, the affine and the two template files (T1w and brain mask) are mirrored under `sdc/prior/` with their notices (#461).
5. **Q61. Masks.**
   **Decided (20 October 2026):** MindGrab (`mindgrab`) of the mean b0 replaces `BrainExtraction` (Q52). MindGrab of the T1w gives `mask_anat`. The user can upload either. Both reference and port use the same masks, made with `@neurodesk/node-drivers/mindgrab` for the reference. The per-stage masks and the dilation stay as sdcflows sets them (section 2.2).
6. **Q62. PE direction and readout time.**
   ds005134 sub-01: the DWI sidecar has `PhaseEncodingDirection` `j-` and `TotalReadoutTime` 0.0379504 s; `EffectiveEchoSpacing` 0.000330004 s × (`ReconMatrixPE` 116 − 1) = 0.0379505 s agrees. The PA `fmap/*_epi` has `j` and the same time. The DWI is 116 × 116 × 69 × 137, 2 mm, LAS, int16, not oblique.
   **Decided (20 October 2026):** take `PhaseEncodingDirection` from the sidecar or the optional sidebar field; never assume one (sdcflows also raises without it, `epi.py:67`). Take `TotalReadoutTime`, else compute it from `EffectiveEchoSpacing` as `get_trt` does (`utils/epimanip.py:233-262`), else ask. Do not use `EstimatedTotalReadoutTime` or sdcflows' `fallback` (`epimanip.py:240-245,292-293`). Refuse without both.
   Note: the corrected images do not depend on the readout time or on the polarity. Both cancel to floating point between `disp_to_fmap` and the unwarp (`transform.py:662-664`, `494-499`; the ridge solve is linear), except one check: `BSplineApprox` stops when `max|coef| ≥ 1e4` Hz after three fits (`bspline.py:203-216`), and a wrong readout time scales the coefficients. Only the Hz map depends on them. The refusal stays because the Hz map is an output and the later joint resampling needs it.
7. **Q63. Outputs.**
   **Decided (20 October 2026):** section 5. The DWI series is unwarped with the Jacobian factor, as `init_unwarp_wf` does by default (`workflows/apply/correction.py:30-32,147`); the reference EPI in the field estimation is unwarped without it (`syn.py:258`), and the app uses that rule only for its QC image.
   The displacement field is `*_from-orig_to-sdc_mode-image_xfm.nii.gz` (section 5).
8. **Q64. Example.**
   The slab (67 × 92 × 10 × 137, 20 mm) has no T1w. ds005134 sub-01 has `anat/sub-01_run-001_T1w.nii.gz` (sagittal MPRAGE, 208 × 320 × 320, 0.8 mm, RAS, 17 420 714 bytes, SHA-256 `fab571879a3f83803405b53a2161f60f58cb32a4a04ee5b54b7b090a61af4a6e`, CC0).
   A T1w crop to the slab breaks the MNI step: an affine to MNI on a 20 mm crop is not reliable.
   **Decided (20 October 2026):** the example ships the full T1w (17 MB) with the slab, so the example runs every step, including the prior. A T1w crop to the slab with "no prior" is not used.
   The full T1w is the example's T1w. #461 adds it to the uploads of #374.
9. **Q65. Runtime and memory.**
   **Decided (20 October 2026):** the estimates of section 7; #461 replaces them with measurements.
   **Measured (#461, 22 October 2026):** section 7 now gives the measured times and memory.
10. **Q66. The gate statistic.**
    **Decided (20 October 2026):** section 6.2. `d` is the median absolute difference in brain between the WASM field and the native double field at the same seed. `spread` is the largest median absolute difference between native seeds (three seeds, three pairs). The WASM field passes when `d ≤ max(spread, 0.05 Hz)` and `d < 0.5 Hz`. The deterministic parts keep fixed tolerances.
    The rule, the 0.05 Hz floor and the 0.5 Hz cap stay. The full-brain Node gate runs in a native workflow job (pull requests that touch the SDC code, nightly, manual). The slab Playwright test is untagged.
11. **Q67. The reference input.**
    **Decided (20 October 2026):** the gate uses the full-brain ds005134 sub-01 (DWI, T1w). The slab is the example only. SyN-SDC on a 20 mm slab is a weak test: the epi-to-anat affine and the prior have little data, and the field's B-spline grid is 11 × 14 × 4. The slab runs in CI against the native slab runs of section 6.1, with report-only numbers. Section 8 lists the issue criteria that this changes.
12. **Q68. The SyN grid (new).**
    sdcflows registers on the EPI field of view at the anat voxel size (0.8 mm here, 14.3 M voxels), which will probably not fit in 4 GiB of WASM memory (section 7). sdcflows' own debug path regrids the anat to 2 mm first (`syn.py:575-585`), and fMRIPrep uses that path with `--sloppy`. Options:
    - (a) stock 0.8 mm grid, if #461 shows that native `--float 1` peaks under about 3.5 GB;
    - (b) 2 mm anat grid with the full `sd_syn.json` schedule. It is `init_syn_preprocessing_wf(debug=True)` with `init_syn_sdc_wf(sloppy=False)`, so the native reference can run it with no code change. `debug=True` also writes extra registration images (`syn.py:489-492`), which do not change the numbers;
    - (c) (a) on the command line and (b) in the browser, each with its own reference.
    **Decided (20 October 2026):** (b) in the browser and on the command line. The command line runs the same wasm32 module in Node, so it has the same 4 GiB limit, and (c) is the same as (b). The gate compares each WASM run with the native 2 mm runs (section 6.2). #461 also runs the stock 0.8 mm grid natively and reports the field difference between the two grids against the 0.8 mm seed spread, and the peak memory of the 0.8 mm `--float 1` run. If that difference is larger than the spread, this decision is reopened.
    **Measured (#461, 22 October 2026): the difference is larger than the spread, so Q68 is reopened.**
    - `fmap` on the 2 mm grid against the 0.8 mm grid at the same seed: 2.78, 2.81 and 2.68 Hz (median_M; p95 12.6-13.0 Hz). The 0.8 mm seed spread is 1.81 Hz (p95 4.20 Hz). The 2 mm seed spread is 2.71 Hz.
    - Memory: the 0.8 mm `--float 1` SyN had a max RSS of 6.97 GB (double 13.10 GB). Option (a) needs under about 3.5 GB, so it is still not possible in the 4 GiB wasm32 heap. Time: 77 min for that SyN on one thread (section 7).
    - Not decided here. The maintainer decides what to do; for example, keep (b) and state the grid difference, or look for a grid between 0.8 mm and 2 mm that fits.
    **Measured (24 October 2026, `sdc/reference/grid-q68/` at dataset commit `e773666d`):** native `--float 1` SyN on a 1.2 mm grid peaks at 2.13-2.19 GB (1.6 mm: 0.98-1.01 GB), and its `fmap` differs from the 0.8 mm double run by 1.24-1.95 Hz over the three seeds (1.6 mm: 2.04-2.59 Hz). On the same grid, `--float 1` against double end to end is 0.539 Hz at 1.2 mm and 0.312 Hz at 1.6 mm.
    **Decided (25 October 2026, #462):** 1.2 mm, and the 0.5 Hz cap stays. The next experiment brings the same-grid float/double difference under 0.5 Hz without `antsRegistration3DDouble` (for example with float64 accumulation in the metric or the field update) and measures the WASM memory at 1.2 mm against the budget. If no change passes the cap, that result is reported before any fallback to 1.6 mm.
    **Measured (#462, 29 October 2026; section 6.2 and section 7):** on the 1.2 mm grid the committed kernel passes the SyN-only replay (0.084 Hz) and fails the end-to-end cap (0.538 Hz), because of the float `epi2anat` affine. Float64 accumulation in ITK's Mattes metric (PDFs, metric value and the affine's derivative; deriv64) brings both replay modes below the 0.5 Hz cap natively (0.040 and 0.154 Hz) and in WASM (0.031 Hz end to end; its SyN warp is pdf64's, 0.040 Hz), without `antsRegistration3DDouble`. Full native end-to-end Q66 acceptance is undetermined: its double seed spread was not measured. In WASM, SyN's linear-memory capacity grows to about 4 GiB, above the about 3.5 GB target, and its largest growth target is 3.94 GiB. Neither value measures peak live allocations or available allocation headroom. Not decided here: whether SDC ships deriv64 (it changes the Mattes registrations of the shared module), and what to do about memory at 1.2 mm; 1.6 mm is not chosen.
    **Measured (29 October 2026, dlmalloc; section 6.2 and section 7):** rebuilt with dlmalloc, WASM deriv64 runs end to end with every kernel program in WASM at d = 0.031 Hz (seed 1234), which meets both conditions of Q66 because d is under the 0.05 Hz floor. It leaves HMC's 101 Q53 registrations byte for byte unchanged (`GC` metric) but changes the package's Mattes test-pair goldens, and it would change BISON's Mattes FLAIR rigid (not measured). The committed dlmalloc kernel completes the 1.2 mm SyN call in a Chromium module worker at 2,155,610,112 bytes of linear memory.
13. **Q69. `sd_syn_sloppy.json` (new; the issue asks if the app offers it).**
    **Decided (20 October 2026):** no, not in the first version. It has 10 times fewer iterations in stage 1 and 5 times fewer in stage 2, and it changes the B-spline fit (`zooms_min` 4.0). It would need its own reference and gate. Revisit after #461 if the full schedule is too slow.
    **Measured (#461):** on the 2 mm grid `sloppy=True` differs from the full schedule by 1.44 Hz (median_M; p95 8.80 Hz), and its SyN took 53 s against 83 s. The full 2 mm SyN is not the slow step (section 7). This measurement does not change the decision.
14. **Q70. N4 of the T1w (new).**
    fMRIPrep gives sdcflows a bias-corrected T1w (smriprep). sdcflows does not correct the T1w itself.
    **Decided (20 October 2026):** the app uses the T1w as the user gives it, and the reference does the same, so the gate compares like with like. The About text says that a bias-corrected T1w is better.
    No N4 step in the first version.
15. **Q71. Who creates `apps/sdc` (new).**
    #465 and #473 both start from `pnpm new-app sdc`.
    **Decided (20 October 2026):** the first of the two to start creates `apps/sdc` and `models/sdc.manifest.json`. The other adds its method with the method selector. The app is GPL-3.0 when PyHySCO ships (#473); the SyN-SDC code stays Apache-2.0. The About text states that only SyN-SDC writes a corrected DWI series (section 8).
    One app for both methods, with the output difference of section 8.
