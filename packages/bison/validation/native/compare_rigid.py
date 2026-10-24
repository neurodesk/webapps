"""Compare FLAIR-to-T1 rigid transforms by the FLAIR position of T1 brain points.

Usage: python -I compare_rigid.py <T1 brain mask .nii> name=<file> [name=<file> ...]
A .xfm is MINC (FLAIR RAS -> T1 RAS); a .mat is ITK (T1 LPS -> FLAIR LPS).
"""

import re
import sys

import nibabel as nib
import numpy as np
from scipy.io import loadmat

LPS = np.diag([-1.0, -1.0, 1.0])


def itk_map(path):
    m = loadmat(path)
    key = next(
        k
        for k in m
        if k.startswith(("AffineTransform", "MatrixOffset", "Euler", "Rigid"))
    )
    p = m[key].ravel().astype(float)
    a = p[:9].reshape(3, 3)
    t = p[9:12]
    c = m["fixed"].ravel().astype(float)

    def f(ras):
        x = ras @ LPS
        y = (x - c) @ a.T + t + c
        return y @ LPS

    return f


def xfm_map(path):
    with open(path) as f:
        text = f.read().split("Linear_Transform =")[1]
    v = np.array([float(x) for x in re.findall(r"[-+0-9.eE]+", text)][:12]).reshape(
        3, 4
    )
    m = np.eye(4)
    m[:3] = v
    inv = np.linalg.inv(m)

    def f(ras):
        return ras @ inv[:3, :3].T + inv[:3, 3]

    return f


img = nib.load(sys.argv[1])
ijk = np.argwhere(np.asanyarray(img.dataobj) > 0)[::50]
pts = nib.affines.apply_affine(img.affine, ijk)
maps = {}
for arg in sys.argv[2:]:
    name, path = arg.split("=", 1)
    maps[name] = (xfm_map if path.endswith(".xfm") else itk_map)(path)(pts)
names = list(maps)
for i, a in enumerate(names):
    for b in names[i + 1 :]:
        d = np.linalg.norm(maps[a] - maps[b], axis=1)
        mean = (maps[a] - maps[b]).mean(axis=0)
        print(
            f"{a} vs {b}: mean {d.mean():.2f} mm, max {d.max():.2f} mm, mean shift RAS {np.round(mean, 2)}"
        )
