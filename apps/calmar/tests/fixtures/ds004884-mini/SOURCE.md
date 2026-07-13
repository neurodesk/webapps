# ds004884 single-subject lesion-segmentation parity fixture

Source: [OpenNeuro **ds004884** v1.0.1](https://openneuro.org/datasets/ds004884/versions/1.0.1)
— the Aphasia Recovery Cohort (Roth et al., *Scientific Data* 2024,
[10.18112/openneuro.ds004884.v1.0.1](https://doi.org/10.18112/openneuro.ds004884.v1.0.1)).

Subject: **sub-M2051**, session **ses-284**. Chronic stroke, large
left-hemisphere territory.

Files:

- `T1.nii.gz` — `acq-tfl3p2_run-4_T1w` from the upstream release, byte-
  equivalent (re-saved by nibabel; same affine / data).
- `lesion_mask.nii.gz` — drawn on `acq-spc3_run-5_T2w` upstream
  (`derivatives/lesion_masks/...`). Resampled to the **T1 voxel grid**
  here via nilearn `resample_to_img(interpolation='nearest')`; same-session
  T1↔T2 affines are near-identical so this is a clean spatial transform,
  not a registration. Stored as `uint8`. **130,972 voxels** of stroke =
  1.249 % of the volume; bounding box `x ∈ [13, 75], y ∈ [42, 197], z ∈ [81, 171]`.

License: ds004884 is **CC0 1.0** on OpenNeuro. The original mask
contributors and the cohort authors should still be cited if these files are
re-used beyond this repo.

## Rebuild

```sh
python3 tests/fixtures/ds004884-mini/build.py
```

Re-runs against the upstream S3 URLs and overwrites these committed files.
The result is reproducible across machines as long as OpenNeuro doesn't
update the upstream release.
