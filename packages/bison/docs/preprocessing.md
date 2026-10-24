# Preprocessing

`src/preprocess.js` runs the steps of `validation/native/run_native.sh` (masked order-1
`volume_pol` variant) with tools that run in a browser. `src/register.js` builds the ANTs argv.
The tools are injected, so the browser worker and the command line run the same code:

| Driver | Node (`src/node.js`) | Use |
| --- | --- | --- |
| `createRegistration()` | `@neurodesk/hmc-registration` `loadHmcRegistration` | `antsRegistration` and `--apply` |
| `createDenoiser()` | `@neurodesk/ants-denoise` `loadDenoise` | `DenoiseImage` |
| `niimath(args, files)` | `@neurodesk/node-drivers/niimath` with `@niivue/niimath` 1.4.20261016 | `-n4` |
| `ort`, `sessionOptions` | `onnxruntime-node` 1.29.0, CPU | the forest (`src/classify.js`), used by `src/pipeline.js` |

`preprocess()` calls `checkpoint(name, bytes)` with every intermediate file, `onProgress(message)`
before each step and `onLog(line)` with the tools' logs. `result.timings` holds the seconds per step.

## Step mapping

"Template" is the ICBM 2009c nonlinear symmetric T1 (`Av_T1`) and "Mask" its brain mask, both
from the official MNI release. `fitVolumePol` with them reproduces the native expression files
(`test/preprocess-native.test.js`), so they stand in for BISON's `Av_T1.mnc` and `Mask.mnc`.

| Native step | Here | Checkpoint |
| --- | --- | --- |
| `bestlinreg_s2 T1 Av_T1` | `antsRegistration`: Rigid then Affine, GC (global correlation, regular 25 % sampling), shrink 8x4x2x1, smoothing 3x2x1x0 vox, centre-of-mass start | `T1toTemplate0GenericAffine.mat` |
| `mincresample Mask -invert_transform -nearest` | `--apply` on the T1 grid, `NearestNeighbor`, inverse affine | `T1_Mask.nii` |
| `mincnlm -beta 0.7` | `DenoiseImage` defaults: Gaussian, patch 1, search 2, shrink 1; mask = linear mask | `T1_NLM.nii` |
| `nu_correct -mask -iter 200 -distance 50` | `niimath -n4` with a four-level schedule, see [N4](#n4) | `T1_N4.nii.gz` |
| `volume_pol --order 1 --noclamp --source_mask <lin mask> --target_mask Mask` | `fitVolumePol` + `applyVolumePol` | `T1_norm`, `T1_VP.nii` |
| `bestlinreg_s2 T1_VP Av_T1` + `nlfit_s -level 2` | one `antsRegistration`: Affine (shrink 4x2x1) started from the first affine, then `SyN[0.1,3,0]` with CC radius 2, shrink 8x4x2, smoothing 3x2x1 vox (affine stage GC) | `T1toTemplate_pp0GenericAffine.mat`, `..1Warp.nii.gz`, `..1InverseWarp.nii.gz` |
| `mincresample Mask -invert_transformation -nearest` | `--apply` on the T1 grid, `NearestNeighbor`, inverse full transform | `Mask_nl.nii` |
| BISON `itk_resample` of `SP_k`, `Av_T1`, `Av_FLAIR` | `--apply` on the T1 grid, `BSpline[2]`, inverse full transform | `<mode>/sp_<k>.nii`, `av_t1.nii`, `av_flair.nii` |
| `bestlinreg_s2 -lsq6 FLAIR T1 -mi -close` | `antsRegistration` Rigid, Mattes MI (32 bins), shrink 4x2x1, identity start (`-close`) | `FLAIRtoT10GenericAffine.mat` |
| FLAIR mask (`xfmconcat`, inverted, `-nearest`) | `--apply` on the FLAIR grid, `NearestNeighbor`, inverse rigid then inverse T1 affine | `FLAIR_Mask.nii` |
| FLAIR `mincnlm`, `nu_correct`, `volume_pol` to `Av_FLAIR` | as for T1, with the FLAIR mask | `FLAIR_NLM.nii`, `FLAIR_N4.nii.gz`, `FLAIR_norm`, `FLAIR_VP.nii` |
| `mincresample FLAIR_VP -transform FLAIRtoT1.xfm -like T1_VP` | `--apply` on the T1 grid, `Linear`, rigid | `FLAIR_CR.nii` |

The second T1 registration starts from the first affine instead of starting again as
`bestlinreg_s2` does: the normalised T1 has the raw T1's grid, so the first affine is already
close. SyN stops at shrink 2 on the 1 mm template because `nlfit_s -level 2` stops at a 2 mm step;
a full-resolution SyN level would multiply the single-threaded run time.

## Metric choice

Same-modality registrations (T1 or T1_VP to the template) use correlation metrics, as the native
tools do (`bestlinreg_s2` optimises minctracc's xcorr). Only the FLAIR rigid uses Mattes mutual
information (`-mi`). Measured on sub-HML0541 (`validation/preprocess-reference.mjs` and single-stage
runs from the same checkpoints), against the native reference:

| Variant | Result | Seconds |
| --- | --- | ---: |
| T1 affine, Mattes | linear mask Dice 0.968, 1154 mL (native 1208 mL) | 131 |
| T1 affine, GC | linear mask Dice 0.975, 1211 mL | 94 |
| SyN, Mattes, 100x70x50 | r(warped Av_T1, native warped Av_T1) 0.63 | 223 |
| SyN, Mattes, 200x200x100, step 0.2 | r 0.69 | 354 |
| SyN, CC radius 2, 100x70x50 | r 0.85 | 689 |

r is Pearson's correlation inside the native classification mask. The native warped Av_T1 itself
correlates 0.82 with the native T1_VP; the priors are classifier inputs, so the warp must match.
`affineArguments({ metric })` and `nonlinearArguments({ affineMetric, synMetric })` take another
metric name from `METRICS`.

Every `antsRegistration` has `--float 1`, `--random-seed 1234` (`DEFAULT_SEED`),
`--collapse-output-transforms 1`, `--winsorize-image-intensities [0.005,0.995]` and no histogram
matching. Identical template images (BISON and BISON-WMH share `SP_1..7`) are resampled once.

## Transform direction and order

An `antsRegistration` transform maps fixed points to moving points. The template is the fixed
image of both T1 registrations, the T1 the fixed image of the FLAIR registration. So
`0GenericAffine.mat` and `1Warp` map template to T1, and the rigid maps T1 to FLAIR.
`1InverseWarp` holds the inverse field: `--apply` refuses `inverse:` on a displacement field.

`hmc --apply` applies the **last** listed transform first to an output point: `apply.cxx` adds the
transforms to an ITK composite in command-line order, and ITK applies the queue from the back.
`test/register.test.js` checks this with a translation and a scaling that do not commute.
`antsApplyTransforms` is the other way round: ANTs' parser stores repeated options with
`push_front`, so its composite is built in reverse and the first listed transform acts first. The
same file list therefore means different mappings in the two programs. The lists in
`src/register.js` are written for hmc:

| Output grid | Point mapping | hmc list |
| --- | --- | --- |
| T1, linear | T1 to template: inverse affine | `inverse:lin.mat` |
| T1, full | T1 to template: inverse affine, then inverse warp | `nl_inverse.nii.gz inverse:nl.mat` |
| FLAIR | FLAIR to T1 (inverse rigid), then T1 to template (inverse affine) | `inverse:lin.mat inverse:rigid.mat` |
| T1, FLAIR image | T1 to FLAIR: rigid | `rigid.mat` |

## N4

`niimath -n4` (1.4.20261016, `src/n4` of niimath v1.0.20261016) ports ANTs N4. On the same input,
mask and options, its single-level output equals ANTs `N4BiasFieldCorrection` (minc-toolkit
2037a07) to 1e-6 relative; its four-level output differs from ANTs by a median 0.9 % per voxel
with the same correction quality (sub-HML0774, below).

N4 is not N3, and `nu_correct`'s options do not carry over one to one. BISON runs N4 with its own
four-level schedule:

| nu_correct | niimath -n4 |
| --- | --- |
| `-distance 50` (knot spacing, mm), `-iter 200`, `-stop 0.001` | `-bspline 200 -iter 50x50x50x50 -convergence 0`: knots 200 mm apart, halved at each of four levels (25 mm at the last), 50 iterations each, no early stop |
| `-fwhm 0.15` (default) | `-fwhm 0.15` |
| shrink 4 (default) | `-shrink 4` |
| 200 histogram bins | `-bins 200` |
| Wiener noise 0.01 | `-wiener 0.01` |
| `-mask <lin mask>` | `-weight <lin mask>` |

The direct translation, one level of `-iter 200` with `-bspline 50` and `-convergence 0.001`, stops
after a few iterations: N4's threshold is not N3's `-stop`. It leaves a field that brightens the
centre of the brain. Against N3 on the native denoised T1 and the native linear mask of each
validation subject (field = corrected / input inside the mask, scaled to the WM median; tissue from
the native labels):

| Subject | Field r with N3, direct / four-level | Deep GM / WM, N3 / direct / four-level | WM CoV, N3 / direct / four-level |
| --- | --- | --- | --- |
| sub-HML0541 | 0.772 / 0.932 | 0.885 / 0.952 / 0.873 | 0.062 / 0.071 / 0.065 |
| sub-HML0654 | 0.874 / 0.951 | 0.907 / 0.965 / 0.901 | 0.058 / 0.078 / 0.063 |
| sub-HML0689 | 0.793 / 0.893 | 0.914 / 0.959 / 0.902 | 0.055 / 0.070 / 0.060 |
| sub-HML0774 | 0.863 / 0.936 | 0.898 / 0.961 / 0.894 | 0.056 / 0.086 / 0.062 |
| sub-HML0962 | 0.787 / 0.927 | 0.896 / 0.963 / 0.881 | 0.064 / 0.074 / 0.068 |

With the direct translation, sub-HML0774's labels agreed with the native ones in 0.898 of the voxels
(WM Dice 0.872, WMH Dice 0.735); with the native `T1_VP` in its place, 0.962. On sub-HML0774, ANTs
with one level and `-convergence 0` (WM CoV 0.069), with shrink 1 (0.076) and with 25 mm knots
(0.063) were also tried; the four-level schedule is N4's default iteration scheme and was best on
every subject. The scripts are `validation/native/README.md`'s "N4 schedule" section.

Labels against the native reference (`ref-final`) on the five subjects, T1 + FLAIR mode, direct
translation then four-level schedule (`validation/pipeline-reference.mjs`, `compare-outputs.mjs`):

| Subject | Voxel agreement | WM Dice | WMH Dice | WMH ml, ours / native |
| --- | --- | --- | --- | --- |
| sub-HML0541 | 0.931 / 0.940 | 0.921 / 0.936 | 0.910 / 0.927 | 15.3 / 16.3 |
| sub-HML0654 | 0.921 / 0.942 | 0.902 / 0.937 | 0.909 / 0.882 | 7.2 / 8.3 |
| sub-HML0689 | 0.932 / 0.944 | 0.926 / 0.946 | 0.920 / 0.912 | 11.8 / 12.6 |
| sub-HML0774 | 0.898 / 0.933 | 0.872 / 0.926 | 0.735 / 0.772 | 8.0 / 11.1 |
| sub-HML0962 | 0.933 / 0.940 | 0.920 / 0.939 | 0.903 / 0.926 | 9.9 / 9.6 |

The schedule raised every tissue class on every subject. WMH stays the weakest class, and on four
subjects our WMH volume is lower. On sub-HML0774 each FLAIR step was replaced in turn by the native
one, with our volume_pol and resampling after it (`validation/swap-inputs.mjs`):

| FLAIR_CR made from | WMH Dice | WMH ml (native 11.1) |
| --- | --- | --- |
| our DenoiseImage and N4 | 0.772 | 8.0 |
| native mincnlm, our N4 | 0.811 | 9.1 |
| native mincnlm and N3 | 0.926 | 11.2 |
| the native FLAIR_CR | 0.938 | 11.2 |

So N4 against N3 on the FLAIR costs most of the WMH difference, and the denoising filter the rest.
The FLAIR rigid transforms agree to 0.09 mm, and from N3 our `volume_pol` gives the native
coefficient (0.00062703) exactly. Of the N4 schedules, four levels is also closest to N3 on this
FLAIR (field r 0.945; three levels 0.80, the direct translation 0.73).

We accept this difference and do not port N3: it is a separate MINC and Perl toolchain that is
no longer maintained. On the other four subjects, WMH Dice is 0.88 to 0.93.
`test/pipeline-native.test.js` holds WMH Dice at 0.751 or more and the WMH volume within 3.5 mL.

`-mask` is ANTs `-x`: voxels outside it keep the input and, by default, the inside is rescaled to
the input range. `nu_correct` fits the field inside its mask and divides every voxel by it. With
`-weight` and no `-mask`, niimath does the same: only voxels with weight > 0 take part in the fit,
and the field divides every voxel. This matters because the classification mask reaches beyond the
linear mask. The output is float32 (`-odt float`). An order-1 `volume_pol` fit through the origin
removes any global scale.

## Kernel instances

One hmc kernel instance aborts on its 27th run (#537). `registrationSession` loads a new instance
for each group of runs (T1 affine and linear mask; nonlinear, `Mask_nl` and the template images;
FLAIR) and after 20 runs or an abort. A new denoiser is loaded for each image.

## Measured on sub-HML0541

`validation/preprocess-reference.mjs`, T1 + FLAIR, Node 22, one thread per tool, against the native
reference (`validation/native/preproc_nifti.py` and the ref-masked export checkpoints). Dice for
masks; for images Pearson's r inside the native classification mask (N4: inside the native linear
mask).

| Checkpoint | Agreement with native | Step | Seconds |
| --- | --- | --- | ---: |
| `T1_Mask` | Dice 0.975 (gate 0.97) | T1 affine | 124 |
| `T1_N4` vs `T1_N3` | r 0.985 | T1 denoise | 49 |
| `T1_VP` | r 0.984, mean 68.5 vs 68.4 | T1 N4 | 2 |
| `Mask_nl` | Dice 0.975 | T1 volume_pol | 1 |
| `av_t1`, `av_flair` | r 0.84, 0.87 | T1 affine + SyN | 999 |
| `t1-flair/sp_8`, `sp_9` | r 0.89, 0.89 | `Mask_nl` + 12 template images | 16 |
| `FLAIR_Mask` | Dice 0.962 | FLAIR rigid | 130 |
| `FLAIR_N4` vs `FLAIR_N3` | r 0.989 | FLAIR denoise | 16 |
| `FLAIR_CR` | r 0.64 | FLAIR N4, volume_pol, resample | 2 |
| | | Total | 1352 |

`volume_pol`: T1 `0.473881*A[0]` (native `0.459001*A[0]` from N3), FLAIR `0.663595*A[0]`
(native `0.658723*A[0]`). The native preprocessing took 1973 s (`nlfit_s` 1764 s).

`FLAIR_CR` differs from the native one more than the other images: this FLAIR on this T1 grid
correlates 0.62 with this T1_VP, the native FLAIR_CR 0.47 with the native T1_VP. `inverse:rigid.mat`
in place of `rigid.mat` drops the agreement to 0.25, so the direction is right; the two rigid
registrations differ.
