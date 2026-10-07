"""Write the NIfTI reader fixtures with nibabel, independently of NiftiUtils.js.

Run from packages/components: python3 test/fixtures/make_nifti_fixtures.py
The values asserted in test/nifti-reference.test.js are the ones written here.
"""
from pathlib import Path

import nibabel as nib
import numpy as np

here = Path(__file__).parent

# Voxel (x, y, z) stores x + 2y + 6z; the image reads back as 10 + 0.5 * stored.
stored = np.arange(24, dtype=np.int16).reshape((2, 3, 4), order="F")

# LPS axes, anisotropic voxels, off-centre origin: sform only.
sform = np.array(
    [
        [-0.5, 0.0, 0.0, 90.0],
        [0.0, -0.75, 0.0, 126.0],
        [0.0, 0.0, 2.0, -72.0],
        [0.0, 0.0, 0.0, 1.0],
    ]
)
image = nib.Nifti1Image(stored, sform)
image.header.set_slope_inter(0.5, 10.0)
image.set_sform(sform, code=1)
image.set_qform(None, code=0)
nib.save(image, here / "sform-int16-scaled.nii.gz")

# Qform only: 90 degree rotation about z (quaternion b=c=0, d=sqrt(0.5)),
# so voxel i runs along +y and voxel j along -x.
qform = np.array(
    [
        [0.0, -2.0, 0.0, 5.0],
        [1.0, 0.0, 0.0, -7.0],
        [0.0, 0.0, 3.0, 11.0],
        [0.0, 0.0, 0.0, 1.0],
    ]
)
image = nib.Nifti1Image(np.arange(24, dtype=np.float32).reshape((2, 3, 4), order="F") / 4, None)
image.set_qform(qform, code=1)
image.set_sform(None, code=0)
nib.save(image, here / "qform-float32.nii")
