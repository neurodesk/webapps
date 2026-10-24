# BISON native MINC reference

This directory makes the reference that the `bison` app and command line are
checked against. It runs the upstream BISON scripts, unchanged, on MINC
preprocessing done the way the upstream `-d` option intends, and keeps every
intermediate file.

- T1 only, 8 classes: `BISON_L8.py` from [VANDAlab/BISON](https://github.com/VANDAlab/BISON)
  at `94dd5f81ad1f0956dc9492195bae050b45a2c6dd`, classifier `RF0_T1exists_T2_PD_FLAIR.pkl`.
- T1 + FLAIR, 9 classes: `BISON_L9.py` from [VANDAlab/BISON-WMH](https://github.com/VANDAlab/BISON-WMH)
  at `ee973dfefd017edbab3f20a8206cbce0e9d060c2`, classifier `RF0_T1exists_T2_PD_FLAIRexists.pkl`.

Both run in `PT` mode without `-d`. The driver does the preprocessing itself (see
[Divergences](#divergences-from-upstream)).

## Environment

| Item | Version |
| --- | --- |
| Host | `epic` (32 cores, 123 GB), every tool on one thread |
| MINC toolkit | 1.9.18-20260305 (`/opt/minc-toolkit-2037a07`) |
| ANTs (diagnostic only) | `/opt/ANTs/bin/DenoiseImage`, ANTs 2.6.5.dev70-g66794b6 |
| Python | 3.10.21 in a uv venv, pinned by `requirements.txt` (numpy 1.26.4, scikit-learn 1.0.2, SimpleITK 2.5.6, nibabel 5.4.2) |

## Files

| File | Purpose |
| --- | --- |
| `subjects.json` | OpenNeuro ds007522 snapshot 2.0.1 inputs: immutable `?versionId=` URL, bytes, sha256 |
| `setup_native.sh` | Stages the `-p` libraries and the upstream scripts, creates the venv |
| `fetch_subjects.py` | Downloads and verifies the inputs |
| `run_native.sh` | Preprocessing, geometry check, both BISON runs, export |
| `ants_denoise.sh` | Diagnostic: DenoiseImage in place of `mincnlm` |
| `geometry_check.py` | Decides the `XFMs` column empirically |
| `bison_export.py` | Rebuilds X, checks it against upstream, writes NIfTI outputs and parity arrays |
| `compare_runs.py` | Determinism: compares two runs by raw and content hash |
| `summarize.py` | Prints the run time, class volume and geometry tables |
| `collect.sh` | Copies a subject's results from the run host |
| `itk_to_xfm.py` | Writes an `antsRegistration` `.mat` as a MINC `.xfm` (`--flair-reg ants`) |
| `compare_rigid.py` | Compares rigid transforms by the FLAIR position of T1 brain points |
| `n4_schedule.sh` | Diagnostic: ANTs N4 schedules on the native denoised T1 and linear mask |
| `n4_compare.py` | Scores bias-corrected T1 images against N3 (tissue ratios, WM CoV, field r) |

## Commands

```bash
W=~/scratch/bison                     # work dir on epic
git clone https://github.com/VANDAlab/BISON.git     upstream/BISON     # checkout 94dd5f8
git clone https://github.com/VANDAlab/BISON-WMH.git upstream/BISON-WMH # checkout ee973df
driver/setup_native.sh $W upstream/BISON upstream/BISON-WMH
$W/venv/bin/python -I driver/fetch_subjects.py driver/subjects.json $W/data
systemd-run --user --unit=bison-<sub> --collect \
  /bin/bash driver/run_native.sh $W <sub> <run-name> \
  [--denoise mincnlm|ants-rician|ants-gaussian] [--volpol unmasked|masked-order1|masked-order2] \
  [--xfm inverse|forward] [--stages preproc,geometry,bison,export]
$W/venv/bin/python -I driver/compare_runs.py $W/runs/<run-a>/<sub> $W/runs/<run-b>/<sub> out.json
driver/collect.sh epic scratch/bison/runs/<run>/<sub> <local dest>
```

`setup_native.sh` stages two `-p` directories:

- `lib/L8`: the contents of `Pretrained_Library.zip` (`SP_1..8`, `Mask`, `T1_Label.pkl`,
  `RF0_T1exists_T2_PD_FLAIR.pkl`) plus `Av_T1.mnc` from the BISON repository root.
- `lib/L9`: the BISON-WMH root assets (`Av_T1`, `Av_FLAIR`, `SP_1..9`, `Mask`,
  `T1_Label.pkl`, `FLAIR_Label.pkl`) plus the unzipped `RF0_T1exists_T2_PD_FLAIRexists.pkl`.

`lib/MANIFEST.sha256` lists every staged file. `Av_T1.mnc` and `Mask.mnc` are the
same bytes in both libraries, and `SP_1..7` are the same; only `SP_8` differs
(white matter without WMH in L9). So one preprocessing serves both modes.

### Preprocessing (`run_native.sh`, stage `preproc`)

Every tool runs with `ITK_GLOBAL_DEFAULT_NUMBER_OF_THREADS=1 OMP_NUM_THREADS=1` and
`TMPDIR` inside the run directory. `commands.log` holds the exact command lines,
`timings.tsv` the wall time of each step. `<id>` is the subject, `Av_T1`, `Av_FLAIR`
and `Mask` are the `lib/L9` files.

| Step | Command | Output |
| --- | --- | --- |
| T1 to MINC | `nii2mnc -clobber T1w.nii.gz <id>_T1.mnc` | raw T1 |
| T1 linear | `bestlinreg_s2 <id>_T1.mnc Av_T1.mnc <id>_T1toTemplate.xfm` | |
| T1 mask | `mincresample Mask.mnc -transform <id>_T1toTemplate.xfm <id>_T1_Mask.mnc -invert_transform -like <id>_T1.mnc -nearest -clobber` | N3 and denoise mask |
| T1 denoise | `mincnlm -clobber -mt 1 <id>_T1.mnc <id>_T1_NLM.mnc -beta 0.7 -clobber` | |
| T1 N3 | `nu_correct <id>_T1_NLM.mnc <id>_T1_N3.mnc -mask <id>_T1_Mask.mnc -iter 200 -distance 50 -clobber` | |
| T1 normalise | `volume_pol <id>_T1_N3.mnc Av_T1.mnc --order 1 --noclamp --expfile <id>_T1_norm --clobber <id>_T1_VP.mnc` | `<id>_T1_norm` holds the fitted minccalc expression |
| T1_VP linear | `bestlinreg_s2 <id>_T1_VP.mnc Av_T1.mnc <id>_T1toTemplate_pp_lin.xfm` | |
| T1_VP to template | `mincresample <id>_T1_VP.mnc -transform <id>_T1toTemplate_pp_lin.xfm <id>_T1_lin.mnc -like Av_T1.mnc -clobber` | |
| Nonlinear | `nlfit_s <id>_T1_lin.mnc Av_T1.mnc <id>_T1toTemplate_pp_nlin.xfm -level 2 -clobber` | grid in `<id>_T1toTemplate_pp_nlin_grid_0.mnc` |
| Concatenate | `xfmconcat <id>_T1toTemplate_pp_lin.xfm <id>_T1toTemplate_pp_nlin.xfm <id>_T1toTemplate_pp_both.xfm` | subject to template |
| Invert | `xfminvert <id>_T1toTemplate_pp_both.xfm <id>_TemplatetoT1_pp_both.xfm` | template to subject |
| Mask_nl | `mincresample Mask.mnc -transform <id>_T1toTemplate_pp_both.xfm <id>_Mask_nl.mnc -like <id>_T1_VP.mnc -invert_transformation -nearest -clobber` | classification region |
| FLAIR to MINC | `nii2mnc -clobber FLAIR.nii.gz <id>_FLAIR.mnc` | |
| FLAIR to T1 | `bestlinreg_s2 -lsq6 <id>_FLAIR.mnc <id>_T1.mnc <id>_FLAIRtoT1.xfm -mi -close` | rigid, mutual information |
| FLAIR to template | `xfmconcat <id>_FLAIRtoT1.xfm <id>_T1toTemplate.xfm <id>_FLAIRtoTemplate_lin.xfm` | |
| FLAIR mask | `mincresample Mask.mnc -transform <id>_FLAIRtoTemplate_lin.xfm <id>_FLAIR_Mask.mnc -invert_transform -like <id>_FLAIR.mnc -nearest -clobber` | |
| FLAIR denoise | `mincnlm -clobber -mt 1 <id>_FLAIR.mnc <id>_FLAIR_NLM.mnc -beta 0.7 -clobber` | |
| FLAIR N3 | `nu_correct <id>_FLAIR_NLM.mnc <id>_FLAIR_N3.mnc -mask <id>_FLAIR_Mask.mnc -iter 200 -distance 50 -clobber` | |
| FLAIR normalise | `volume_pol <id>_FLAIR_N3.mnc Av_FLAIR.mnc --order 1 --noclamp --expfile <id>_FLAIR_norm --clobber <id>_FLAIR_VP.mnc` | |
| FLAIR on T1 grid | `mincresample <id>_FLAIR_VP.mnc -transform <id>_FLAIRtoT1.xfm <id>_FLAIR_CR.mnc -like <id>_T1_VP.mnc -clobber` | trilinear |

### Geometry check (stage `geometry`)

For both candidate XFMs (`forward` = `<id>_T1toTemplate_pp_both.xfm`, `inverse` =
`<id>_TemplatetoT1_pp_both.xfm`):

```bash
itk_resample Mask.mnc --like <id>_T1_VP.mnc --transform <cand> --labels geometry/mask_<cand>.mnc --clobber
itk_resample lib/L8/SP_1.mnc --like <id>_T1_VP.mnc --transform <cand> geometry/sp1_<cand>.mnc --clobber
minc_qc.pl <id>_T1_VP.mnc --mask geometry/sp1_<cand>.mnc geometry/sp1_<cand>.jpg --big --clobber --image-range 0 200 --mask-range 0 1
```

`geometry_check.py` writes `geometry/geometry.json`. See [XFM direction](#xfm-direction).

### BISON (stage `bison`)

```bash
# t1/list.csv:       Subjects,T1s,Masks,XFMs
# t1-flair/list.csv: Subjects,T1s,Masks,XFMs,FLAIRs
#   T1s = <id>_T1_VP.mnc, Masks = <id>_Mask_nl.mnc, XFMs = the chosen XFM, FLAIRs = <id>_FLAIR_CR.mnc
venv/bin/python -I scripts/BISON_L8.py -c RF0 -m lib/L8 -p lib/L8 -e PT -l 8 -n t1/list.csv -t t1/tmp/ -o t1/out -j 1 --nifti
venv/bin/python -I scripts/BISON_L9.py -c RF0 -m lib/L9 -p lib/L9 -e PT -l 9 -n t1-flair/list.csv -t t1-flair/tmp/ -o t1-flair/out -j 1 --nifti
```

`-t` gets a random prefix (`<dir><n>_BISON_`). The driver copies
`*_BISON_test_0_0_{sp_<k>,av_t1,av_flair}.mnc` (the `itk_resample` outputs) to
`<mode>/warped/` under stable names.

### Export (stage `export`)

`bison_export.py` rebuilds X from the checkpoint files exactly as PT mode does and
asserts that `predict` equals the upstream `RF0_<id>_Label.mnc` inside the mask and
that sklearn's float32 cast changes neither `predict` nor `predict_proba`. It writes
`<mode>/export/`:

| File | Content |
| --- | --- |
| `X.npy` | float32 (N, F), F = 18 (t1) or 33 (t1-flair) |
| `mask_index.npy` | int64 (N,): linear voxel index in the native NIfTI T1 (i fastest); rows of X follow this order |
| `mask_ijk.npy` | int32 (N, 3): the same voxels as (i, j, k) |
| `classes.npy` | `clf.classes_` (0..8 or 0..9) |
| `predict.npy`, `predict_proba.npy` | int32 (N,), float32 (N, n_classes) in `classes.npy` order |
| `nifti/<t1>_bison-labels.nii.gz` | uint8 labels on the native T1 grid; 0 outside the mask, and 0 may occur inside |
| `nifti/<t1>_bison-prob-<class>.nii.gz` | float32, class 1..n in the correct order |
| `nifti/<t1>_bison-mask.nii.gz` | uint8, `Mask_nl` |
| `nifti/checkpoints/` | `T1_VP`, `FLAIR_CR`, `sp_<k>`, `av_t1`, `av_flair` on the native T1 grid |
| `summary.json` | feature columns, class counts and volumes, upstream probability-file check |

Feature columns: t1 = `SP_1..8, T1, Av_T1, T1_hist_1..8`; t1-flair =
`SP_1..9, T1, Av_T1, T1_hist_1..9, FLAIR, Av_FLAIR, FLAIR/T1, 0, FLAIR_hist_1..9`.
T1 and FLAIR are clipped in place to [1, 255] before every use, so the ratio uses
clipped values. The histogram index is `np.round` (half to even) cast to int32.

The NIfTI files use the original T1 affine. `nii2mnc` keeps the voxel order, so the
SimpleITK MINC array (z, y, x) transposed is the NIfTI (i, j, k) array; the export
checks this on the raw T1 (largest difference 3e-5, MINC slice scaling). The MINC
files cannot go to NIfTI through SimpleITK directly: ITK reads MINC world
coordinates as LPS without converting from RAS.

`summarize.py <runs dir> <run>/<subject> ...` prints the run time, class volume
and geometry tables below from a run tree.

## XFM direction

The `XFMs` column must map template to subject: `xfminvert` of
`T1toTemplate_pp_both.xfm`. This agrees with the upstream README ("Nonlinear
transformation from template to primary modality image"). The upstream `-d` code
writes `T1toTemplate_pp_both.xfm` (subject to template) into that column, which is
wrong. `itk_resample` does not invert by default (`--invert_transform` is an option),
and it uses the XFM as the ITK output-to-input mapping.

Evidence on sub-HML0541 (`geometry/geometry.json`, identical in both smoke runs):

| Candidate | Dice of `itk_resample Mask.mnc` with `Mask_nl` | mean T1_VP where SP_1 > 0.5 | ratio to mask mean (61.4) |
| --- | ---: | ---: | ---: |
| forward (`T1toTemplate_pp_both.xfm`) | 0.578 | 56.7 | 0.92 |
| inverse (`TemplatetoT1_pp_both.xfm`) | 1.000 | 25.1 | 0.41 |

`Mask_nl` itself agrees with the linear mask (Dice 0.953). `geometry/sp1_inverse.jpg`
shows SP_1 filling the lateral ventricles; `sp1_forward.jpg` shows it scattered over
the basal cisterns and white matter. `run_native.sh` therefore defaults to
`--xfm inverse`.

## Determinism

sub-HML0541 ran twice (`smoke-a`, `smoke-b`) on one thread per tool.
`compare_runs.py` found all 130 compared files equal in content: every MINC voxel
array and geometry, every XFM and N3 field file (without `%` comment lines), the
`volume_pol` expressions, the exported `.npy` and `.nii.gz`. Raw bytes differ only
where the tools write timestamps or paths: 61 `.mnc` (history attribute), 7 `.xfm`
and 2 `.imp` (`%` comment lines), 2 upstream `mnc2nii` `.nii`. The 12 `.npy` and
44 exported `.nii.gz` files are byte-identical.

## Smoke subject results (sub-HML0541)

| Step | Wall time (s) |
| --- | ---: |
| Preprocessing, T1 + FLAIR | 1973 (nlfit_s 1680, FLAIR bestlinreg_s2 149) |
| BISON_L8.py (t1) | 188 |
| BISON_L9.py (t1-flair) | 234 |
| Export, each mode | 45-52 |

| Mode | ventricles | csf | cerebellar-gm | cerebellar-wm | brainstem | deep-gm | cortical-gm | wm | wmh | label 0 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| t1 (mL) | 74.5 | 141.8 | 116.8 | 24.0 | 19.6 | 40.9 | 555.1 | 281.2 | | 0 |
| t1-flair (mL) | 66.6 | 139.3 | 95.1 | 15.2 | 5.2 | 18.4 | 494.8 | 23.0 | 396.2 | 0 |

Checks that passed in both modes:

- `predict` on the rebuilt X equals the upstream `RF0_<id>_Label.mnc` at every mask
  voxel, and the upstream file is 0 outside the mask.
- `predict` and `predict_proba` on `X.astype(float32)` equal those on the float64 X.
- Upstream `Prob_Label_k` holds the probability of class k-1 (largest difference
  3e-8, the float32 MINC storage). `classes_` starts at 0, so `Prob_Label_1` is
  class 0 and the last class is never written. The export writes class k to
  `prob-<class k>`.
- `volume_pol` output equals the printed coefficient times the N3 image
  (T1: `0.411519*A[0]`, largest difference 5e-5; FLAIR: `1.20489*A[0]`, 2.5e-4), so a
  port can use the 6-digit coefficient from the expression file. The least-squares
  coefficient from the images is 0.4115189 and 1.2048909.
- The FLAIR mask covers the brain (1207.7 mL, the same as the T1 linear mask) and
  the FLAIR to T1 registration is correct on the QC image.

### Known problem: unmasked volume_pol on this FLAIR

The t1-flair result is wrong: 396 mL WMH and 23 mL WM. The cause is the upstream
intensity normalisation, not the classifier or the geometry. `volume_pol` without
masks fits the whole-volume histograms, and this FLAIR has a dark scalp while
`Av_FLAIR` has a bright one. Inside the brain mask FLAIR_CR has median 73 while the
warped `Av_FLAIR` has median 41 (5th/95th percentiles 9/90 against 15/46). White
matter at about 75 against 42 looks like WMH to the classifier. T1 is closer
(T1_VP brain median 65 against Av_T1 72.6) and the t1 result is plausible.

Upstream's FLAIR `-d` path never ran (`_FLAIR_Mask.mnc` is never written and
`str_t1_proc` is misspelt), so the code does not show how the published BISON-WMH
models were normalised. Upstream has a masked variant commented out
(`--order 2 --source_mask <lin mask> --target_mask Mask.mnc`). The driver's
`--volpol masked-order1|masked-order2` reproduces it as a diagnostic. Fitted
coefficients on sub-HML0541: T1 `0.459001*A[0]` (masked, order 1) and
`0.292639*A[0]+27.4302` (masked, order 2), against `0.411519*A[0]` unmasked.

### Decision: masked order 1 is the reference

Unmasked `volume_pol` fails the t1-flair mode on all 5 subjects (WMH 365-440 mL, WM
6-61 mL). Masked order 2 shrinks CSF to 14 mL (t1) and 5 mL (t1-flair) on
sub-HML0541. Masked order 1 (`--volpol masked-order1`) gives plausible volumes on all
5 subjects, so the gated reference is run `ref-masked` and the app uses the same
normalisation in both modes. The upstream unmasked run stays as `ref` for comparison.

| Subject | t1 WM | t1-flair WM | t1-flair WMH | unmasked t1-flair WMH |
| --- | ---: | ---: | ---: | ---: |
| sub-HML0541 | 358.0 | 342.5 | 15.7 | 396.2 |
| sub-HML0654 | 355.6 | 345.5 | 8.2 | 364.8 |
| sub-HML0689 | 388.6 | 376.8 | 12.3 | 440.3 |
| sub-HML0774 | 393.4 | 381.7 | 11.1 | 407.4 |
| sub-HML0962 | 327.8 | 317.3 | 9.5 | 371.7 |

Volumes in mL. `ref-masked/sub-HML0541` is the `diag-volpol-masked-order1` run.

## FLAIR registration

On sub-HML0541 the upstream FLAIR to T1 rigid (`bestlinreg_s2 -lsq6 -mi -close`, minctracc)
is about 2 mm off. Over the T1 brain mask, the FLAIR position of each point differs by:

| Comparison | sub-HML0541 mean (max) | sub-HML0654 mean (max) |
| --- | ---: | ---: |
| minctracc against native `antsRegistration` | 2.20 mm (2.98) | 0.51 mm (1.04) |
| minctracc against the app (hmc-registration) | 2.18 mm (2.92) | |
| native `antsRegistration` against the app | 0.04 mm (0.08) | |

The shift is 2.2 mm in z. On a sagittal QC image the minctracc FLAIR ventricle edges sit
low against the T1 ventricles; the ANTs ones sit on them. With the minctracc FLAIR_CR as the
reference, WMH Dice of the app was 0.55; with our intensities and the minctracc transform
it was 0.90, so the transform is the whole difference.

The reference run `ref-final` therefore uses `--flair-reg ants`: native `antsRegistration`
Rigid, Mattes MI (32 bins, regular 25 % sampling), four levels, one thread, seed 1, from the
raw T1 and FLAIR. `itk_to_xfm.py` writes it as `FLAIRtoT1.xfm` (checked: 0.00 mm from the
`.mat`), and every later step is unchanged. `ref-final` reuses the T1 preprocessing and t1
results of `ref-masked`. `compare_rigid.py` made the table.

## N4 schedule

The web app replaces `nu_correct` (N3) with N4, which `niimath -n4` ports. The direct translation of
`-iter 200 -distance 50 -stop 0.001` (one level, 50 mm knots, convergence 0.001) stops early and left
sub-HML0774's labels at 0.898 agreement with the native ones. To pick the N4 schedule on the native
inputs, so that only the bias correction differs:

```bash
source /opt/minc-toolkit-2037a07/minc-toolkit-config.sh
n4_schedule.sh ~/scratch/bison/runs/ref-final sub-HML0774 ~/scratch/bison/n4schedule/sub-HML0774
python -I n4_compare.py ~/scratch/bison/n4schedule/sub-HML0774 \
  <ref-final>/t1-flair/export/nifti/sub-HML0774_ses-01_rec-defaced_T1w_bison-labels.nii.gz \
  ants_direct ants_direct_noconv ants_direct_shrink1 ants_knots25 ants_four_level
```

N4's own four-level schedule (`-b [200] -c [50x50x50x50,0]`) was closest to N3 on all five subjects;
[docs/preprocessing.md](../../docs/preprocessing.md#n4) has the table and the niimath comparison.

## Divergences from upstream

1. No `-d`: the driver does the preprocessing and passes the results to PT mode.
2. `XFMs` = `xfminvert T1toTemplate_pp_both.xfm` (template to subject), not
   `T1toTemplate_pp_both.xfm` as `-d` writes. See [XFM direction](#xfm-direction).
3. FLAIR N3 mask: upstream `-d` passes `<id>_FLAIR_Mask.mnc` to `nu_correct` but never
   creates it. The driver maps `Mask.mnc` through `xfmconcat FLAIRtoT1.xfm
   T1toTemplate.xfm` (the first, raw-T1 linear XFM), inverted, onto the FLAIR grid
   with nearest neighbour.
4. FLAIR_CR: upstream `-d` registers FLAIR_VP to T1_VP a second time
   (`FLAIRtoMain.xfm`, `-lsq6 -mi -close`) and resamples with it. The driver skips the
   second registration and resamples FLAIR_VP with `FLAIRtoT1.xfm`. This is
   geometrically the same mapping: `volume_pol`, `mincnlm` and `nu_correct` keep the
   grid, and T1_VP has the raw T1 grid.
5. `str_t1_proc` typo in `-d`: not reached, because the driver does not use `-d`.
6. Upstream writes `Prob_Label_k` with class k-1 (off by one). The export writes the
   correct class to each `prob-<class>` file; the upstream files stay in `<mode>/out`.
7. Determinism settings: `ITK_GLOBAL_DEFAULT_NUMBER_OF_THREADS=1`,
   `OMP_NUM_THREADS=1`, `-mt 1` on `mincnlm` (upstream also uses it), `-j 1` on BISON.
8. `volume_pol` uses `--source_mask <lin mask> --target_mask Mask.mnc` with `--order 1` in
   the reference run `ref-masked`. See [the decision](#decision-masked-order-1-is-the-reference).
9. FLAIR to T1 rigid in `ref-final`: native `antsRegistration` (`--flair-reg ants`), not
   `bestlinreg_s2`. See [FLAIR registration](#flair-registration).
10. `bestlinreg_s2`, `nlfit_s`, `nu_correct`, `mincnlm` and `volume_pol` use exactly
   the upstream arguments; no option was added except in the diagnostic variants.

## Diagnostic variants (sub-HML0541 only)

| Run name | Change |
| --- | --- |
| `diag-ants-rician` | `--denoise ants-rician`: DenoiseImage defaults (Rician, patch 1, search 2), masked, one thread |
| `diag-ants-gaussian` | `--denoise ants-gaussian`: as above with `-n Gaussian` (the browser design) |
| `diag-volpol-masked-order1` | `--volpol masked-order1` |
| `diag-volpol-masked-order2` | `--volpol masked-order2` (upstream's commented-out line) |

T1 `volume_pol` coefficients after DenoiseImage: `0.40159*A[0]` (Rician),
`0.405144*A[0]` (Gaussian), against `0.411519*A[0]` after `mincnlm`.

## Data

`subjects.json` lists sub-HML0541 (smoke), sub-HML0962, sub-HML0689, sub-HML0654 and
sub-HML0774, ses-01 `rec-defaced` T1w and FLAIR from OpenNeuro ds007522 snapshot
2.0.1. The sha256 values are the git-annex keys from the snapshot; `fetch_subjects.py`
verified every download against them.
