#!/usr/bin/env python3
"""Store an upstream MuscleMap label map as a small uint16 .nii.gz fixture.

Usage: pack_upstream_reference.py <upstream_dseg.nii.gz> <fixture.nii.gz>
Label values are unchanged; gzip is written without a timestamp so the fixture's bytes depend
only on the labels.
"""
import gzip
import sys

import nibabel as nib
import numpy as np

source = nib.load(sys.argv[1])
values = np.asarray(source.dataobj)
labels = values.astype(np.uint16)
if not np.array_equal(labels, values):
    raise SystemExit("Upstream labels are not integers that fit uint16")
image = nib.Nifti1Image(labels, source.affine)
image.set_data_dtype(np.uint16)
with open(sys.argv[2], "wb") as handle:
    with gzip.GzipFile(fileobj=handle, mode="wb", mtime=0, filename="") as archive:
        archive.write(image.to_bytes())
present = np.unique(labels[labels > 0])
print(f"{sys.argv[2]}: {int(np.count_nonzero(labels))} labelled voxels, {present.size} labels")
