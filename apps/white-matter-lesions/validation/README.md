# Choosing a FLAIR lesion segmentation method for the browser

The app needs a method that works from a FLAIR image alone, on both vascular white matter
hyperintensities and multiple sclerosis lesions, with weights we may redistribute, and that runs
in a browser tab in minutes. This directory holds the comparison that picked FLAMeS and the
checks that the browser port reproduces it. Measured 2026-09-29.

## Candidates

| Method | Input | Weights and licence | Browser fit |
| --- | --- | --- | --- |
| [FLAMeS](https://doi.org/10.5281/zenodo.17955359) (nnU-Net, 2025) | FLAIR, skull-stripped | 5 folds, 31 M parameters each; CC BY 4.0 on Zenodo v2 (its Hugging Face copy says CC BY-NC 4.0; the app uses the Zenodo release) | 3D patches; 62 MB per fold as float16 |
| [MindGlide](https://github.com/MS-PINPOINT/mindGlide) (MONAI DynUNet, 2025) | any contrast, no preprocessing | 123 MB; MIT | 3D patches |
| [sysu_media](https://github.com/hongweilibran/wmh_ibbmTum) (MICCAI 2017 winner) | FLAIR, or FLAIR + T1 | 3 × 35 MB 2D U-Nets; GPL-3.0 | 2D slices; fixed intensity threshold for the brain mask |
| [WMH-SynthSeg](https://github.com/freesurfer/freesurfer/tree/dev/mri_WMHsynthseg) (FreeSurfer, 2024) | any contrast | 790 MB checkpoint; FreeSurfer licence | whole 1 mm volume at once |
| [LST-AI](https://github.com/CompImg/LST-AI) (2024) | FLAIR **and** T1 | MIT | excluded: needs a T1 |
| LST-LPA (SPM toolbox) | FLAIR | SPM/MATLAB | excluded: no open runtime to port |

## Data

- **WMH**: 25 scans of the MICCAI 2017 WMH challenge test set, five per scanner group
  (Amsterdam GE 1.5 T, GE 3 T and Philips, Singapore, Utrecht), drawn with `random.seed(0)`.
  Label 2 (other pathology) is excluded from scoring. The data are CC BY-NC 4.0; the Hugging Face
  mirror `MedOtter/wmh-segmentation` labels them CC BY 4.0, which is wrong, so they are used for
  scoring only. sysu_media was trained on this challenge's training scans from three of these
  groups, so its WMH scores are in-domain.
- **MS**: the 22 patients of the MSLesSeg test split
  ([doi:10.6084/m9.figshare.27919209](https://doi.org/10.6084/m9.figshare.27919209), CC BY 4.0),
  1 mm MNI space, already skull-stripped.

Scores are the WMH challenge's voxel Dice, absolute volume difference (AVD, %) and 26-connected
lesion recall and F1. FLAMeS WMH inputs were skull-stripped with SynthStrip 1.6 (`--no-csf` unless
stated in the table). CPU times are on a shared 16-core virtual machine and only indicative.

## Results

Mean over cases. Dice, AVD %, lesion recall, lesion F1.

| Method | WMH (n = 25) | MS (n = 22) |
| --- | --- | --- |
| sysu_media, FLAIR only | **0.760**, 46.3, **0.902**, 0.638 | 0.549, 44.1, 0.699, 0.450 |
| FLAMeS, 5 folds, nnU-Net itself (no mirroring) | 0.714, 53.8, 0.725, **0.750** | **0.648**, 44.1, 0.777, **0.716** |
| FLAMeS, 5 folds, this port (`reference.py`) | 0.710, 55.3, 0.726, 0.748 | 0.647, 44.7, 0.782, 0.717 |
| **App, ensemble** (SynthStrip with CSF) | 0.733, 38.3, 0.658, 0.734 | 0.647, 44.7, 0.782, 0.717 |
| **App, one fold (default)** (SynthStrip with CSF) | 0.726, 43.9, 0.690, 0.730 | 0.608, 83.7, 0.789, 0.700 |
| MindGlide | 0.569, 132.8, 0.559, 0.509 | 0.338, 381.7, 0.661, 0.366 |
| WMH-SynthSeg | not completed: 26 GB resident and 32 min into the first scan | — |

The MS inputs are already skull-stripped, so the app's *already skull-stripped* path applies
there and the app rows equal the port's.

What decided it:

- sysu_media leads on WMH, but it was trained on those sites, and on MS lesions it falls to Dice
  0.55 and lesion F1 0.45. It is 2D, masks the brain with a raw-intensity threshold of 30 that
  depends on scanner scaling, and its weights are GPL-3.0.
- FLAMeS is second on WMH at the voxel level, first on lesion F1, and first on MS. It needs only a
  FLAIR, the shared SynthStrip port supplies the skull stripping, and its licence allows
  redistribution.
- MindGlide over-segments both cohorts (AVD 133 % and 382 %).
- WMH-SynthSeg processes the whole 1 mm volume with 64 base features. On this machine one scan
  exceeded 26 GB of memory, far beyond a browser tab. Published comparisons also place its Dice
  well below dedicated FLAIR models ([segcsvd](https://doi.org/10.1002/hbm.70104)).

Browser-configuration choices. One fold is the default: it downloads 62 MB instead of 310 MB and
runs five times faster. It costs 0.007 Dice on WMH and 0.039 on MS, where fold 0 alone
over-segments (AVD 84 % against 45 %), so the ensemble is offered in the advanced settings.
SynthStrip with CSF, which the repository already ships, suits the app: with it the ensemble
scores 0.733 on WMH, against 0.710 with FLAMeS's recommended `--no-csf`. Float16 weight storage
changes no score at three decimals.

An earlier version of the port skipped the plans' `transpose_forward` and resampled trilinearly.
Its Dice was 0.02 to 0.05 lower and its ensemble gained nothing over one fold; the rows above
replace those measurements.

## Port checks

- `parity.mjs` runs `packages/white-matter-lesions/src/pipeline.js` with ONNX Runtime Web
  (WebAssembly) against `reference.py` on the same skull-stripped input and model. Utrecht 9: Dice 0.998, 111 of about
  34 500 lesion voxels differ, from float rounding between runtimes. The port's resampling matches
  nnunetv2's `resample_data_or_seg_to_shape` to 2.4 × 10⁻⁷ on anisotropic and isotropic volumes,
  and on the 22 MS scans its five-fold masks agree with `nnUNetv2_predict`'s at Dice 0.97 to 0.99.
- The exported graph matches the PyTorch checkpoint in ONNX Runtime; the transposed-convolution
  rewrite changes no output (max difference 0). On WebGPU (Chromium, SwiftShader) a 32 × 64 × 64
  export of the same graph agreed with native ONNX Runtime to 2 × 10⁻⁴ in the logits and on every
  voxel's class. SwiftShader is software rendering, so it gives no GPU timing.
- The shipped example (MSLesSeg P57, clinical 2.3 mm FLAIR) runs in the built app on eight
  WebAssembly threads in 3 minutes with one fold (90 lesions, 31.5 ml) and 10 minutes with the
  ensemble (77 lesions, 29.6 ml). The expert mask for that patient, in MNI space, holds 42.1 ml.
  `browser-reference.json` pins these results; the end-to-end test re-measures them in Chromium,
  and the `flames` command line's release check must reproduce them.

## Reproduce

```sh
# work directory holding the data, the exported folds (flames-fold0.onnx …) and out/
python score.py wmh <work> <method>...
python score.py ms <work> <method>...
python reference.py <work> v_f0_csf --inputs stripped_csf --model 'flames-fold{}.onnx'
node parity.mjs <work>/stripped_csf/Utrecht_9.nii.gz <work>/out/v_f0_csf/Utrecht_9.nii.gz <work>/flames-fold0.onnx
```

`subset.json` lists the WMH cases and `results.json` holds every per-case score above. The other
candidates ran through their own tools:
`nnUNetv2_predict -d 4 -c 3d_fullres -tr nnUNetTrainer_8000epochs -f 0 1 2 3 4 --disable_tta`
for FLAMeS, `mindglide -i in/ -o out/mindglide/`, and sysu_media's `test_tf2.py` functions with
`two_modalities = False`.
