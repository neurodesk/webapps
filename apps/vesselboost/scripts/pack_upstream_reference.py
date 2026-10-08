#!/usr/bin/env python3
"""Store an upstream VesselBoost binary segmentation as a small uint8 .nii.gz fixture.

Usage: pack_upstream_reference.py <upstream_output.nii> <fixture.nii.gz>
The voxels are unchanged (non-zero becomes 1); gzip is written without a timestamp so the
fixture's bytes depend only on the mask.
"""
import gzip
import sys

import nibabel as nib
import numpy as np

source = nib.load(sys.argv[1])
mask = (np.asarray(source.dataobj) > 0).astype(np.uint8)
image = nib.Nifti1Image(mask, source.affine)
image.set_data_dtype(np.uint8)
with open(sys.argv[2], "wb") as handle:
    with gzip.GzipFile(fileobj=handle, mode="wb", mtime=0, filename="") as archive:
        archive.write(image.to_bytes())
print(f"{sys.argv[2]}: {int(mask.sum())} vessel voxels of {mask.size}")
