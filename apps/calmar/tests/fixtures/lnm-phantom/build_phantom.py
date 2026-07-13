#!/usr/bin/env python3
"""Build the deterministic Phase 1c.4 smoke-test phantom.

Writes a binary lesion mask to lesion-mni2.nii.gz on the same MNI152NLin2009c
2mm grid as web/models/manifest.json's yeo7-2mm atlas (dims = 99 x 117 x 95).
The mask is a 4x4x4 cube placed inside the Yeo Visual parcel (label 1) so
the smoke test outcome is fully deterministic:

  - totalLesionVoxels = 64
  - voxelsOutsideAtlas = 0  (no warning surfaces)
  - all 64 voxels in the Visual network -> single non-zero bar in the table.

Run once after `pip install nilearn nibabel`; the resulting .nii.gz is
committed alongside this script. Re-run if the atlas grid ever changes.
"""

import os
import sys
import hashlib

import numpy as np
import nibabel as nib

HERE = os.path.dirname(os.path.abspath(__file__))
# Atlas source: the same fetch path the Yeo upload step used. If the cached
# file is missing, nilearn re-fetches from the FreeSurfer FTP.
ATLAS_PATH = "/tmp/yeo_fetch/Yeo7_LiberalMask_2mm.nii.gz"
OUT_PATH = os.path.join(HERE, "lesion-mni2.nii.gz")
CUBE_SIZE = 4   # 4 x 4 x 4 = 64 voxels, large enough for a robust bar.


def find_visual_seed(atlas_data, cube=CUBE_SIZE, target_label=1):
    """Find a corner (i, j, k) such that atlas[i:i+cube, j:j+cube, k:k+cube]
    is entirely target_label. Walk the grid in raster order; return the first
    fit. Reproducible across re-runs."""
    nx, ny, nz = atlas_data.shape
    for k in range(nz - cube + 1):
        for j in range(ny - cube + 1):
            for i in range(nx - cube + 1):
                block = atlas_data[i:i + cube, j:j + cube, k:k + cube]
                if np.all(block == target_label):
                    return (i, j, k)
    raise RuntimeError(
        f"No {cube}x{cube}x{cube} cube of label {target_label} found in the atlas."
    )


def main():
    if not os.path.exists(ATLAS_PATH):
        sys.exit(
            f"Yeo atlas missing at {ATLAS_PATH}. Re-run the Phase 1c.2 upload "
            "step (or run `python -c 'from nilearn.datasets import "
            "fetch_atlas_yeo_2011; fetch_atlas_yeo_2011()'`) and resample to "
            "MNI152NLin2009cAsym 2mm."
        )

    atlas_img = nib.load(ATLAS_PATH)
    atlas_data = np.asarray(atlas_img.dataobj).astype(np.int16)
    expected_dims = (99, 117, 95)
    if atlas_data.shape != expected_dims:
        sys.exit(f"Atlas dims {atlas_data.shape} != expected {expected_dims}")

    seed = find_visual_seed(atlas_data, cube=CUBE_SIZE, target_label=1)
    print(f"Phantom corner (i, j, k) = {seed}; placing {CUBE_SIZE}^3 cube of label 1.")

    mask = np.zeros(atlas_data.shape, dtype=np.int16)
    i, j, k = seed
    mask[i:i + CUBE_SIZE, j:j + CUBE_SIZE, k:k + CUBE_SIZE] = 1

    out_img = nib.Nifti1Image(mask, atlas_img.affine, header=atlas_img.header)
    out_img.set_data_dtype(np.int16)
    nib.save(out_img, OUT_PATH)

    size = os.path.getsize(OUT_PATH)
    sha = hashlib.sha256(open(OUT_PATH, "rb").read()).hexdigest()
    print(f"Wrote {OUT_PATH} ({size} bytes, sha256={sha}).")
    print(f"Total lesion voxels: {int(mask.sum())} (expected {CUBE_SIZE ** 3}).")


if __name__ == "__main__":
    main()
