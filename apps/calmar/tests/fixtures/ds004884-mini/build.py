#!/usr/bin/env python3
"""Rebuild the ds004884 single-subject parity fixture.

Source: OpenNeuro ds004884, the Aphasia Recovery Cohort (Roth et al.,
Scientific Data 2024, https://doi.org/10.18112/openneuro.ds004884.v1.0.1).
Single subject `sub-M2051`, session `ses-284`. T1w + lesion mask only.

The lesion mask in the upstream release is drawn on the T2 acquisition
(`acq-spc3_run-5_T2w_desc-lesion_mask.nii.gz`); within-session T1/T2 share a
near-identity affine, so we resample the mask to the T1 voxel grid via
nilearn (nearest-neighbour) — no registration required. The resulting
`lesion_mask.nii.gz` lives on the T1 grid and is the ground truth that
`scripts/test_lesion_seg_parity.mjs` Dice-compares against the
SynthStroke-baseline output.

License: ds004884 is released under CC0 1.0 on OpenNeuro. Cite Roth et al.
2024 if you re-use the fixture beyond this test.

Run:  python3 tests/fixtures/ds004884-mini/build.py
The committed T1.nii.gz + lesion_mask.nii.gz are reproduced byte-equivalent
on re-run unless OpenNeuro updates the upstream files.
"""
import hashlib
import os
import urllib.request as U
import numpy as np
import nibabel as nib
from nilearn.image import resample_to_img

HERE = os.path.dirname(os.path.abspath(__file__))
S3 = "https://s3.amazonaws.com/openneuro.org"
SUB, SES = "sub-M2051", "ses-284"
T1_KEY = f"ds004884/{SUB}/{SES}/anat/{SUB}_{SES}_acq-tfl3p2_run-4_T1w.nii.gz"
MASK_KEY = (
    f"ds004884/derivatives/lesion_masks/{SUB}/{SES}/anat/"
    f"{SUB}_{SES}_acq-spc3_run-5_T2w_desc-lesion_mask.nii.gz"
)


def fetch(key, cache_name):
    path = os.path.join("/tmp", cache_name)
    if not os.path.exists(path):
        print(f"Fetching {key}...")
        U.urlretrieve(f"{S3}/{key}", path)
    return path


def main():
    t1_in = fetch(T1_KEY, "ds004884_T1.nii.gz")
    mask_in = fetch(MASK_KEY, "ds004884_mask_t2space.nii.gz")

    t1 = nib.load(t1_in)
    mask_t2 = nib.load(mask_in)

    mask_t1 = resample_to_img(
        mask_t2, t1, interpolation="nearest", force_resample=True, copy_header=True
    )
    mask_data = np.asarray(mask_t1.dataobj).astype(np.uint8)
    mask_int = nib.Nifti1Image(mask_data, t1.affine)
    mask_int.set_data_dtype(np.uint8)

    t1_out = os.path.join(HERE, "T1.nii.gz")
    mask_out = os.path.join(HERE, "lesion_mask.nii.gz")
    nib.save(t1, t1_out)
    nib.save(mask_int, mask_out)

    n_lesion = int(mask_data.sum())
    print(f"Wrote {t1_out} ({os.path.getsize(t1_out):,} bytes, "
          f"sha256={hashlib.sha256(open(t1_out,'rb').read()).hexdigest()})")
    print(f"Wrote {mask_out} ({os.path.getsize(mask_out):,} bytes, "
          f"sha256={hashlib.sha256(open(mask_out,'rb').read()).hexdigest()})")
    print(f"Lesion voxels on T1 grid: {n_lesion:,} / {mask_data.size:,} "
          f"({100*n_lesion/mask_data.size:.3f}%)")


if __name__ == "__main__":
    main()
