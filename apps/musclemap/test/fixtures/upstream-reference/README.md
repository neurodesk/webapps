# Upstream MuscleMap reference labels

`body_mri_s0175_slab_musclemap-wholebody-v1.4_dseg.nii.gz` (7 259 bytes, SHA-256
`b23a88ab402a024e217241342edc39a03caddbf56be257c752f008bfe6d121d9`, 45 281 labelled voxels,
26 labels) is the label map upstream MuscleMap produced for the test slab.
`e2e/full-pipeline.spec.js` compares the app's segmentation with it under the release gate of
`scripts/compare_upstream_output.py`: voxel agreement 0.99, foreground Dice 0.95 and Dice 0.95
for every label upstream found. The app did not produce this file.

- Input: `test/body-slab.mjs` cuts axial slices 30-34 (320 x 240 x 5, upper thigh) from the
  pinned example `body_mri_s0175.nii.gz` (TotalSegmentator MRI s0175, CC BY-NC-SA 2.0). Slab
  SHA-256 `be7ee281ebbd5de796afbc33b97752d37036fa943b65fa348685780888b13573`.
- Tool: https://github.com/MuscleMap/MuscleMap at `6e1e1eb6732337c13cab53bd5cc800c69024774f`
  (the revision in `model-sources/release.json`), run natively on macOS arm64 (CPU) in
  upstream's pinned environment: Python 3.11.16, torch 2.4.1, monai 1.3.2, nibabel 5.2.1,
  scikit-image 0.21.0, pandas 2.0.3. numpy 1.26.4, scipy 1.17.1 and scikit-learn 1.8.0 replace
  upstream's pins because those wheels do not load on this macOS.
- Weights: whole-body v1.4 `contrast_agnostic_wholebody_model.pth` from Zenodo record 21929873,
  SHA-256 `45dfa2843d2e0b1fd842152d6a79bfd4bcb90899c076ceb6346c59da9a79a16c` (the checkpoint
  `model-sources/release.json` pins).
- Command, generated 2026-10-03:
  `python mm_segment.py -i body_mri_s0175_slab.nii -r wholebody --model_version 1.4 -o out -g N -s 0 -c 5`,
  then `scripts/pack_upstream_reference.py` to store the labels as uint16.

`scripts/make_upstream_reference.sh` repeats all of it.

## Measured 2026-10-07

App: ONNX Runtime Web 1.21.0, WebAssembly, whole-body v1.4 fp32, overlap 0, source chunk 5.
The app's label map equals upstream's voxel for voxel: agreement 1, foreground Dice 1, all 26
labels Dice 1. `e2e/full-pipeline.spec.js` enforces the full release gate.

The first measurement (2026-10-03, on a branch without
[#135](https://github.com/neurodesk/webapps/pull/135)) found agreement 0.9948, foreground
Dice 0.9878 and 10 of 26 labels below Dice 0.95 (lowest 0.693, label 7162). The cause was the
foreground crop: the app kept every nonzero voxel after z-scoring, where MONAI's
`CropForegroundd` keeps positive ones. On this slab that widened the crop from 394 x 256 to
410 x 299, so each slice ran as two Gaussian-blended 256 x 256 windows instead of one and the
labels moved at their boundaries. Giving upstream's own `mm_segment.py` the nonzero rule
reproduces the old app output exactly (agreement 0.9947995, the same 10 labels); restoring
positive selection in the app alone takes it to agreement 1.
`test/preprocessing-parity.test.js` checks the crop against MONAI on a small array.

Upstream is itself sensitive to library versions on this slab: the same command under torch
2.11.0 and monai 1.5.2 differs from the pinned run in 721 voxels (agreement 0.9981, three
labels below Dice 0.95, lowest 0.892).
