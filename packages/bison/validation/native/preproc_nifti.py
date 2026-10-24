"""Write the native preprocessing checkpoints that the JavaScript preprocessing is compared with as NIfTI.

nii2mnc keeps the voxel order, so the SimpleITK MINC array (z, y, x) transposed is the NIfTI
(i, j, k) array of the raw input (bison_export.py checks this on the raw T1). Each file takes the
raw T1 or FLAIR affine.

Writes to --out: T1_Mask, T1_N3, Mask_nl (T1 grid) and FLAIR_Mask, FLAIR_N3 (FLAIR grid), .nii.gz.
"""

import argparse
from pathlib import Path

import nibabel as nib
import numpy as np
import SimpleITK as sitk

T1_GRID = ["T1_Mask", "T1_N3", "Mask_nl"]
FLAIR_GRID = ["FLAIR_Mask", "FLAIR_N3"]


def convert(mnc, raw, dst):
    array = sitk.GetArrayFromImage(sitk.ReadImage(str(mnc))).transpose(2, 1, 0).astype(np.float32)
    reference = nib.load(str(raw))
    if array.shape != reference.shape[:3]:
        raise SystemExit(f"{mnc}: shape {array.shape} is not the raw grid {reference.shape[:3]}")
    image = nib.Nifti1Image(array, reference.affine)
    image.set_data_dtype(np.float32)
    nib.save(image, str(dst))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--preproc", required=True, type=Path)
    parser.add_argument("--id", required=True)
    parser.add_argument("--raw-t1", required=True, type=Path)
    parser.add_argument("--raw-flair", type=Path)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    jobs = [(name, args.raw_t1) for name in T1_GRID]
    if args.raw_flair:
        jobs += [(name, args.raw_flair) for name in FLAIR_GRID]
    for name, raw in jobs:
        convert(args.preproc / f"{args.id}_{name}.mnc", raw, args.out / f"{name}.nii.gz")
        print(name)


if __name__ == "__main__":
    main()
