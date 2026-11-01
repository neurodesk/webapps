# Preprocessing

`src/preprocess.js` runs the steps of `validation/native/run_native.sh` (masked order-1
`volume_pol` variant) with tools that run in a browser. `src/register.js` builds the `--apply` argv
and converts Greedy's matrices to ITK `.mat` files.
The tools are injected, so the browser worker and the command line run the same code:

| Driver | Node (`src/node.js`) | Use |
| --- | --- | --- |
| `createRegistration()` | `@neurodesk/hmc-registration` `loadHmcRegistration` | `--apply` |
| `createDenoiser()` | `@neurodesk/ants-denoise` `loadDenoise` | `DenoiseImage` |
| `createGreedy()` | `@neurodesk/greedy/single` `loadGreedySingleThread` | the T1 affine, the nonlinear warp and the FLAIR rigid |
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
| `bestlinreg_s2 T1 Av_T1` | Greedy `-a -m NMI -ia-image-centers -n 100x50x10`, template fixed, see [Greedy](#greedy) | `T1toTemplate0GenericAffine.mat` |
| `mincresample Mask -invert_transform -nearest` | `--apply` on the T1 grid, `NearestNeighbor`, inverse affine | `T1_Mask.nii` |
| `mincnlm -beta 0.7` | `DenoiseImage` defaults: Gaussian, patch 1, search 2, shrink 1; mask = linear mask | `T1_NLM.nii` |
| `nu_correct -mask -iter 200 -distance 50` | `niimath -n4` with a four-level schedule, see [N4](#n4) | `T1_N4.nii.gz` |
| `volume_pol --order 1 --noclamp --source_mask <lin mask> --target_mask Mask` | `fitVolumePol` + `applyVolumePol` | `T1_norm`, `T1_VP.nii` |
| `bestlinreg_s2 T1_VP Av_T1` + `nlfit_s -level 2` | Greedy `-sv -m NCC 2x2x2 -n 100x70x50`, T1_VP fixed, template moving, `-it` the inverse first affine, no mask, see [Nonlinear step](#nonlinear-step) | `T1toTemplate_ppWarp.nii` |
| `mincresample Mask -invert_transformation -nearest` | `--apply` on the T1 grid, `NearestNeighbor`, warp then inverse affine | `Mask_nl.nii` |
| BISON `itk_resample` of `SP_k`, `Av_T1`, `Av_FLAIR` | `--apply` on the T1 grid, `BSpline[2]`, warp then inverse affine | `<mode>/sp_<k>.nii`, `av_t1.nii`, `av_flair.nii` |
| `bestlinreg_s2 -lsq6 FLAIR T1 -mi -close` | Greedy `-a -dof 6 -m NMI -n 100x50x10`, T1 fixed, identity start (`-close`) | `FLAIRtoT10GenericAffine.mat` |
| FLAIR mask (`xfmconcat`, inverted, `-nearest`) | `--apply` on the FLAIR grid, `NearestNeighbor`, inverse rigid then inverse T1 affine | `FLAIR_Mask.nii` |
| FLAIR `mincnlm`, `nu_correct`, `volume_pol` to `Av_FLAIR` | as for T1, with the FLAIR mask | `FLAIR_NLM.nii`, `FLAIR_N4.nii.gz`, `FLAIR_norm`, `FLAIR_VP.nii` |
| `mincresample FLAIR_VP -transform FLAIRtoT1.xfm -like T1_VP` | `--apply` on the T1 grid, `Linear`, rigid | `FLAIR_CR.nii` |

The nonlinear registration starts from the first affine instead of starting again as
`bestlinreg_s2` does: the normalised T1 has the raw T1's grid, so the first affine is already
close. It runs to the 1 mm level although `nlfit_s -level 2` stops at a 2 mm step: stopping at 2 mm
failed a CSF gate ([Nonlinear step](#nonlinear-step)).

## Metric choice

The nonlinear registration uses neighbourhood cross-correlation, the metric closest to
`bestlinreg_s2`'s minctracc xcorr. This table chose it, when ANTs ran every registration. Measured on
sub-HML0541 (`validation/preprocess-reference.mjs` and single-stage runs from the same
checkpoints), against the native reference:

| Variant | Result | Seconds |
| --- | --- | ---: |
| ANTs T1 affine, Mattes | linear mask Dice 0.968, 1154 mL (native 1208 mL) | 131 |
| ANTs T1 affine, GC | linear mask Dice 0.975, 1211 mL | 94 |
| ANTs SyN, Mattes, 100x70x50 | r(warped Av_T1, native warped Av_T1) 0.63 | 223 |
| ANTs SyN, Mattes, 200x200x100, step 0.2 | r 0.69 | 354 |
| ANTs SyN, CC radius 2, 100x70x50 | r 0.85 | 689 |

r is Pearson's correlation inside the native classification mask. The native warped Av_T1 itself
correlates 0.82 with the native T1_VP; the priors are classifier inputs, so the warp must match.
Greedy's NMI fell short in the same way as Mattes ([Nonlinear step](#nonlinear-step)); its NCC
reaches the CC result. Identical template images (BISON and BISON-WMH share `SP_1..7`) are
resampled once.

## Greedy

Greedy (`@neurodesk/greedy`) runs every registration: the T1 affine and FLAIR rigid with NMI, the
nonlinear warp with NCC. Both the browser worker and Node run Greedy's committed single-threaded
WebAssembly (`wasm-single`), so their transforms are the same bytes; the native `greedy-rs` rounds
differently (the T1 affine differed in the twelfth digit). `greedyMatrixToMat` turns Greedy's RAS
matrix (fixed point to moving point) into the LPS `.mat` that `antsRegistration` would write, so
`--apply` reads it unchanged, and it reads Greedy's warp (LPS displacements on the fixed grid) as a
displacement field. `test/register.test.js` checks that `--apply` through the matrix, and through the
warp and the inverse affine, resamples as Greedy does.

On 2026-10-27 the native reference was rebuilt on five ds007522 subjects with the MINC 1.9.18 and
ANTs 2.6.0 containers from Neurodesk's CVMFS (`--volpol masked-order1 --flair-reg ants`). The ANTs
pipeline reproduced the documented numbers against it (sub-HML0541: linear mask Dice 0.975, label
agreement 0.940, WMH 15.3 against 16.3 mL) and passed every gate of `test/pipeline-native.test.js`.

### Linear steps (switched, #612)

Measured on 2026-10-29 with the whole pipeline in Node (`validation/pipeline-reference.mjs`, one
thread, the five subjects at once on a shared 16-core host), against that reference.
Linear and FLAIR mask Dice are against the native masks; r is Pearson's correlation of the warped
Av_T1 with the native one inside the native classification mask (ANTs SyN, now started from the
Greedy affine). Agreement is the voxel agreement inside both classification masks (t1 / t1-flair).

| Subject | Linear mask Dice | FLAIR mask Dice | r Av_T1 | Agreement | WMH mL (native) | Label gates | Affine s | Rigid s |
| --- | --- | --- | --- | --- | --- | --- | ---: | ---: |
| sub-HML0541 | 0.971 | 0.971 | 0.848 | 0.938 / 0.938 | 15.2 (16.3) | 2 of 2 | 33 | 31 |
| sub-HML0654 | 0.974 | 0.970 | 0.886 | 0.940 / 0.940 | 7.1 (8.3) | 2 of 2 | 33 | 34 |
| sub-HML0689 | 0.977 | 0.976 | 0.882 | 0.943 / 0.943 | 11.7 (12.6) | 2 of 2 | 24 | 39 |
| sub-HML0774 | 0.978 | 0.979 | 0.874 | 0.934 / 0.933 | 8.2 (11.1) | 2 of 2 | 30 | 40 |
| sub-HML0962 | 0.976 | 0.976 | 0.843 | 0.943 / 0.944 | 9.8 (9.7) | 2 of 2 | 38 | 40 |

Every subject passes every gate of `test/pipeline-native.test.js` in both modes, and the linear
mask holds the 0.97 gate; agreement stays within the ANTs range of 0.933-0.944. The mean r of
0.867 is the ANTs-affine pipeline's. The FLAIR mask of sub-HML0654 is 0.9698; its rigid lands within
0.54 mm (mean over T1 brain points, at most 1.07 mm) of the reference's ANTs rigid, and on the five
subjects within 0.22-0.54 mm, so the difference comes from the T1 affine. The ANTs affine and
rigid took 94 and 130 s unloaded (sub-HML0541) and 252-549 s and 325-391 s on this shared host.

The T1 affine's start was chosen by measurement (Greedy's own reslice, linear mask Dice by subject
as in the table):

| T1 affine | 0541 | 0654 | 0689 | 0774 | 0962 | Seconds |
| --- | --- | --- | --- | --- | --- | ---: |
| identity start (Greedy's default) | 0.9708 | 0.9742 | 0.9760 | 0.9780 | 0.9762 | 30-32 |
| `-ia-image-centers` (used) | 0.9713 | 0.9742 | 0.9765 | 0.9780 | 0.9764 | 28-30 |
| `-ia-image-centers -n 100x100x50` | 0.9712 | 0.9745 | 0.9783 | 0.9781 | 0.9770 | 77-83 |
| `-gm` template mask, `-ia` the identity-start affine | 0.9310 | 0.9321 | 0.9704 | 0.9235 | 0.9612 | 19-20 |

The masked affine converges (determinants 0.64-0.73, #623) but fits the template's brain to less of
the head, so it is not used. The longer schedule gains nothing on sub-HML0541 for 2.7 times the time.
The FLAIR rigid from the identity and from image centres gave the same mask Dice.

### Nonlinear step

Greedy writes no inverse warp, so a Greedy SVF brings the template to the T1 grid only with T1_VP
fixed and the template moving (`-it` the inverse Greedy affine). greedy-rs ports upstream Greedy's
NCC (`-m NCC 2x2x2`, the unweighted `MultiComponentWeightedNCCImageMetric`, with its exact gradient)
for this step; on the five subjects it gave the same r as upstream Greedy 1.4 to within 0.004.
Measured on 2026-10-30 and 2026-10-31 with the whole pipeline in Node, as for the linear steps; r
columns are means over the five subjects (Av_T1, then the CSF and cerebellar priors):

| Nonlinear registration | r Av_T1 | r CSF | r cerebellar GM / WM | Label gates passed | Seconds |
| --- | --- | --- | --- | --- | ---: |
| ANTs SyN, CC radius 2 (before) | 0.867 | 0.793 | 0.986 / 0.978 | 10 of 10 | 1372-1615 |
| Greedy NCC 2x2x2, 100x70x50, no mask (used) | 0.873 | 0.797 | 0.990 / 0.985 | 10 of 10 | 567-667 |
| Greedy NCC 2x2x2, 200x100x0, linear mask | 0.891 | 0.829 | 0.985 / 0.980 | 8 of 10 | 173-198 |
| Greedy NCC 2x2x2, 100x50x0, linear mask | 0.883 | 0.817 | 0.985 / 0.979 | 8 of 10 | 92-98 |
| Greedy NMI 400x200x100, mask dilated 4 voxels (#626) | 0.884 | 0.819 | 0.975 / 0.955 | 6 of 10 | 936-1011 |
| Greedy NMI 100x50x0, linear mask | 0.783 | | | | 87-95 |
| none (the Greedy affine only) | 0.525 | | | | |

With the warp used, by subject:

| Subject | r Av_T1 | Classification mask Dice | Agreement | CSF Dice (t1) | WMH mL (native) |
| --- | --- | --- | --- | --- | --- |
| sub-HML0541 | 0.902 | 0.983 | 0.946 / 0.945 | 0.822 | 15.3 (16.3) |
| sub-HML0654 | 0.875 | 0.978 | 0.941 / 0.941 | 0.814 | 7.1 (8.3) |
| sub-HML0689 | 0.872 | 0.978 | 0.943 / 0.943 | 0.794 | 11.6 (12.6) |
| sub-HML0774 | 0.881 | 0.978 | 0.938 / 0.936 | 0.787 | 8.2 (11.1) |
| sub-HML0962 | 0.834 | 0.970 | 0.943 / 0.944 | 0.801 | 9.7 (9.7) |

The masked 2 mm warps correlate better but fail sub-HML0774's CSF gate (0.729-0.737, gate 0.768):
with the metric counted only inside the linear mask, nothing pulls the template's brain edge out to
the T1's, and the classification mask (0.973) left out 42,832 native CSF voxels where ANTs' (0.979)
left out 27,145. Inside both masks CSF Dice was 0.905 against ANTs' 0.913. A mask dilated by 4 or 8
voxels, an NMI or NCC affine refinement on T1_VP, and less field smoothing did not raise that mask;
registering the whole head to 1 mm did. Agreement, 0.936-0.946, is within or above the ANTs range of
0.933-0.944. The single-threaded WebAssembly heap of this step is 1.46 GB, against 2.2 GB for SyN.

## Transform direction and order

A Greedy transform maps fixed points to moving points. The template is the fixed image of the T1
affine, the T1 the fixed image of the FLAIR rigid, and T1_VP the fixed image of the warp, which
Greedy registered from the inverse affine. So the affine maps template to T1, the rigid T1 to FLAIR,
and the warp a T1 point to where the inverse affine then takes it into the template. `--apply`
refuses `inverse:` on a displacement field, and needs none.

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
| T1, full | T1 to template: warp, then inverse affine | `inverse:lin.mat warp.nii` |
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

`registrationSession` loads a new hmc kernel instance for each group of `--apply` runs (linear
mask; `Mask_nl`; the template images; FLAIR), so each group's heap is freed when it
ends, and after an abort. A new denoiser is loaded for each image. One instance can run every
command of a group: the kernel restores its stack after each run, and its tests run 200 times on
one instance (#537, #592).

## Measured on sub-HML0541

Recorded when ANTs ran every registration, before Greedy replaced them ([Greedy](#greedy) has the
current numbers). `validation/preprocess-reference.mjs`, T1 + FLAIR, Node 22, one thread per tool, against the native
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
