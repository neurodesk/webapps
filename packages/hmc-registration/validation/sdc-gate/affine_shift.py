"""How far two ITK affine transforms (.mat) map the voxels of a mask apart, in mm.

    python -I affine_shift.py MASK REFERENCE.mat OTHER.mat [OTHER.mat ...]

For each OTHER, the median, 95th percentile and maximum over the voxel centres of MASK of
|T_other(x) - T_reference(x)|, with x in ITK's LPS coordinates. The #462 results use the
MindGrab mask of the mean b0 and the `epi2anat` affines (transform0GenericAffine.mat).
"""

import sys

import nibabel as nb
import numpy as np
from scipy.io import loadmat


def affine(path):
    """The matrix and offset of an ITK MatrixOffsetTransformBase written as a MATLAB file."""
    m = loadmat(path)
    key = next(k for k in m if k.startswith("AffineTransform"))
    p = m[key].ravel().astype(np.float64)
    centre = m["fixed"].ravel().astype(np.float64)
    matrix = p[:9].reshape(3, 3)
    return matrix, p[9:12] + centre - matrix @ centre


def main(mask_path, reference, *others):
    img = nb.load(mask_path)
    ras = nb.affines.apply_affine(img.affine, np.argwhere(np.asarray(img.dataobj) > 0))
    lps = ras * np.array([-1.0, -1.0, 1.0])
    matrix, offset = affine(reference)
    mapped = lps @ matrix.T + offset
    for other in others:
        m, o = affine(other)
        d = np.linalg.norm(lps @ m.T + o - mapped, axis=1)
        print(
            f"{other}: median {np.median(d):.4g} mm, p95 {np.percentile(d, 95):.4g} mm, max {d.max():.4g} mm"
        )


if __name__ == "__main__":
    if len(sys.argv) < 4:
        sys.exit(__doc__)
    main(*sys.argv[1:])
