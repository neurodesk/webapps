"""Convert each method's output to one field: Hz, topup's sign, on the AP b0 grid.

Usage: fields.py <run-dir> <method>

Every method gives, directly or after conversion, u_ap: the displacement in
voxels along the PE axis such that the corrected AP image is AP(x + u_ap(x)).
The field in Hz is then

    f = u_ap / (S * trt * v_ap)

where v_ap is the AP PE sign (+1 for "j", -1 for "j-") and S is the sign that
relates topup's field to the sampling displacement. S comes from calibrate.py,
which finds the S that reproduces topup's own corrected images. Writes
<run-dir>/<method>/field_hz.nii.gz.
"""

import json
import sys
from pathlib import Path

import nibabel as nb
import numpy as np
from scipy.ndimage import map_coordinates

AXES = "ijk"


def load_field(path):
    """A displacement field as (X, Y, Z, 3) world-mm vectors, RAS."""
    img = nb.load(path)
    data = np.asarray(img.dataobj, dtype=np.float64)
    data = data.reshape(data.shape[:3] + (3,))
    return img, data


def lps_to_ras(vectors):
    out = vectors.copy()
    out[..., 0] *= -1
    out[..., 1] *= -1
    return out


def on_grid(img, data, target):
    """Sample a field defined on img's grid at target's voxel centres."""
    shape = target.shape[:3]
    ijk = np.indices(shape).reshape(3, -1)
    world = target.affine[:3, :3] @ ijk + target.affine[:3, 3:4]
    src = np.linalg.inv(img.affine)
    vox = src[:3, :3] @ world + src[:3, 3:4]
    if data.ndim == 3:
        return map_coordinates(data, vox, order=1, mode="nearest").reshape(shape)
    out = [
        map_coordinates(data[..., c], vox, order=1, mode="nearest").reshape(shape)
        for c in range(data.shape[-1])
    ]
    return np.stack(out, axis=-1)


def pe_voxels(ras_mm, target, axis):
    """The PE-axis voxel component of world-mm RAS vectors."""
    inv = np.linalg.inv(target.affine[:3, :3])
    return ras_mm @ inv[axis]


def u_ap_for(run, method, target, axis):
    d = run / method
    if method in ("topup", "topup-single"):
        return None
    if method == "ants":
        img, w = load_field(d / "ants_0Warp.nii.gz")
        w = on_grid(img, lps_to_ras(w), target)
        # The warp sends AP points to PA points, about u_pa - u_ap = -2 u_ap.
        return -0.5 * pe_voxels(w, target, axis)
    if method.startswith("pyhysco"):
        b = np.asarray(nb.load(d / "pyhysco-EstFieldMap.nii.gz").dataobj, np.float64)
        # Staggered along the PE axis (m + 1 nodes): average to cell centres.
        lo = [slice(None)] * 3
        hi = [slice(None)] * 3
        lo[axis] = slice(0, -1)
        hi[axis] = slice(1, None)
        b = 0.5 * (b[tuple(lo)] + b[tuple(hi)])
        # PyHySCO works in mm on the voxel grid (omega from the voxel size).
        return b / target.header.get_zooms()[axis]
    if method == "qwarp":
        # AFNI warps hold DICOM (LPS) mm displacements. MINUS warps the base (AP).
        img, w = load_field(d / "qwarp_MINUS_WARP.nii.gz")
        w = on_grid(img, lps_to_ras(w), target)
        return pe_voxels(w, target, axis)
    if method == "drbuddi":
        img, w = load_field(d / "deformation_FINV.nii.gz")
        w = on_grid(img, lps_to_ras(w), target)
        return pe_voxels(w, target, axis)
    if method.startswith("fdnet"):
        f = np.asarray(nb.load(d / "fdnet_field_vox.nii.gz").dataobj, np.float64)
        # The K-unit pushes undistorted voxel i to i + field(i) in the first
        # input (out[j] = sum_i im[i] sinc(i + field(i) - j)), so the
        # correction samples the first input at x + field(x).
        u_first = f
        return u_first if method == "fdnet" else -u_first
    raise SystemExit(f"unknown method {method}")


def main(run, method):
    run = Path(run)
    meta = json.loads((run / "prep" / "prep.json").read_text())
    cal = json.loads((run / "calibration.json").read_text())
    target = nb.load(run / "prep" / "ap_mean.nii.gz")
    pe = meta["ap"]["pe"]
    axis = AXES.index(pe[0])
    v_ap = -1.0 if pe.endswith("-") else 1.0
    trt = meta["ap"]["trt"]
    if method in ("topup", "topup-single"):
        f = np.asarray(nb.load(run / method / "topup_fout.nii.gz").dataobj, np.float64)
    else:
        u = u_ap_for(run, method, target, axis)
        f = u / (cal["S"] * trt * v_ap)
    nb.Nifti1Image(f.astype(np.float32), target.affine).to_filename(
        run / method / "field_hz.nii.gz"
    )


if __name__ == "__main__":
    main(*sys.argv[1:])
