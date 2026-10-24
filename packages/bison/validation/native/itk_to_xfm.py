"""Write an antsRegistration affine .mat as a MINC .xfm for mincresample.

Usage: python -I itk_to_xfm.py <fixed-to-moving .mat> <moving-to-fixed .xfm>

The ITK transform maps fixed points to moving points in LPS. The MINC transform maps
moving world points to fixed world points in RAS (source to target, as bestlinreg_s2
writes it), so the result is the inverse of the ITK map conjugated by the LPS flip.
"""

import sys

import numpy as np
from scipy.io import loadmat

LPS = np.diag([-1.0, -1.0, 1.0, 1.0])


def itk_matrix(path):
    m = loadmat(path)
    key = next(k for k in m if k.startswith(("AffineTransform", "MatrixOffset")))
    p = m[key].ravel().astype(float)
    a = p[:9].reshape(3, 3)
    c = m["fixed"].ravel().astype(float)
    out = np.eye(4)
    out[:3, :3] = a
    out[:3, 3] = p[9:12] + c - a @ c
    return out


def main():
    fixed_to_moving = LPS @ itk_matrix(sys.argv[1]) @ LPS
    moving_to_fixed = np.linalg.inv(fixed_to_moving)
    rows = "\n".join(" ".join(f"{v:.15g}" for v in row) for row in moving_to_fixed[:3])
    with open(sys.argv[2], "w") as f:
        f.write(f"MNI Transform File\n% itk_to_xfm.py {sys.argv[1]}\n\n")
        f.write(f"Transform_Type = Linear;\nLinear_Transform =\n{rows};\n")


main()
