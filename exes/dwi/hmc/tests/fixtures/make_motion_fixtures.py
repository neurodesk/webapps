"""Make the motion fixtures for the hmc crate with QSIPrep's own decomposition.

The fixtures are committed, so `cargo test` needs no Python. Rerun only to remake them:

    python -m venv venv
    venv/bin/pip install numpy==1.26.3 scipy==1.11.4 nibabel==5.3.2 transforms3d==0.4.2 \
        SimpleITK==2.5.6
    venv/bin/python -I make_motion_fixtures.py   # writes motion-*.mat and motion.json

Recorded with Python 3.12.3 and exactly those versions: QSIPrep 26.1.1 pins numpy 1.26 and
scipy 1.11 and leaves transforms3d and SimpleITK unpinned.

The oracle is QSIPrep 26.1.1's `get_ras_motion_params` itself
(`qsiprep/interfaces/gradients.py:905-944`, tag 26.1.1, commit 371b537a). Installing QSIPrep
pulls in nipype, dipy, nilearn and scikit-learn for one function, so the script downloads the
pinned `gradients.py`, checks its SHA-256, takes that one function out of it with `ast` and runs
it unchanged, with the module-level names it uses (`np`, `nb`, `R`, `decompose44`) imported as
the module imports them. It reads each transform with SimpleITK from the `.mat` file and each
reference grid from a NIfTI file, as QSIPrep does.

Inputs are synthetic: rigid and affine transforms written with SimpleITK about several centres,
plus the two antsRegistration files of `make_fixtures.py` (one double, one float), on an oblique
LAS grid whose origin lies about 190 mm from its centre (like ds005577) and on an LPS grid.

motion.json holds, per case, QSIPrep's twelve values (scale, shear, rotation, translation) and
the world-centre form (the translation of the world grid centre A·c, with the same rotation),
and, per sequence, framewise displacement by nipype 1.11.0's `FramewiseDisplacement`
(`parameter_source="SPM"`, radius 50; its three lines are copied in `nipype_fd`) and the TSV the
crate must write byte for byte (`motion_tsv`).
"""

import ast
import hashlib
import json
import math
import os
import sys
import tempfile
import urllib.request

import nibabel as nb
import numpy as np
import SimpleITK as sitk
from scipy.spatial.transform import Rotation as R
from transforms3d.affines import decompose44

HERE = os.path.dirname(os.path.abspath(__file__))
QSIPREP_URL = (
    "https://raw.githubusercontent.com/PennLINC/qsiprep/"
    "371b537ad890a390dd7c2e2fa60e4231ffbc364e/qsiprep/interfaces/gradients.py"
)
QSIPREP_SHA256 = "2e92d6c25de3bd76179d2d0de63d53e911fe45b13f3f7e0eedfa3035c320a135"


def qsiprep_function():
    """`get_ras_motion_params`, exactly as QSIPrep 26.1.1 defines it."""
    source = urllib.request.urlopen(QSIPREP_URL).read()
    digest = hashlib.sha256(source).hexdigest()
    if digest != QSIPREP_SHA256:
        raise RuntimeError(f"gradients.py has SHA-256 {digest}, expected {QSIPREP_SHA256}")
    tree = ast.parse(source)
    node = next(
        n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "get_ras_motion_params"
    )
    if (node.lineno, node.end_lineno) != (905, 944):
        raise RuntimeError(f"get_ras_motion_params is at lines {node.lineno}-{node.end_lineno}")
    namespace = {"np": np, "nb": nb, "R": R, "decompose44": decompose44}
    exec(compile(ast.Module(body=[node], type_ignores=[]), QSIPREP_URL, "exec"), namespace)
    return namespace["get_ras_motion_params"]


def rotation(axis, angle):
    axis = np.asarray(axis, dtype=float)
    return R.from_rotvec(axis / np.linalg.norm(axis) * angle).as_matrix()


def oblique_las():
    """112x112x60 at 2 mm, LAS, tilted 10.6 degrees about x, origin far from the centre."""
    zooms = np.diag([-2.0, 2.0, 2.2])
    tilt = rotation([1, 0, 0], math.radians(10.6))
    affine = np.eye(4)
    affine[:3, :3] = tilt @ zooms
    affine[:3, 3] = [110.5, -95.25, -48.75]
    return [112, 112, 60], affine


def conformed_lps():
    """96x96x64 at 2.5 mm, LPS (x and y reversed in RAS), as QSIPrep's conformed b0_mean."""
    affine = np.diag([-2.5, -2.5, 2.5, 1.0])
    affine[:3, 3] = [118.75, 131.25, -72.5]
    return [96, 96, 64], affine


def rigid(rotvec, translation):
    m = np.eye(3)
    angle = np.linalg.norm(rotvec)
    if angle > 0:
        m = R.from_rotvec(rotvec).as_matrix()
    return m, np.asarray(translation, dtype=float)


def affine_part(rotvec, translation, scale, shear):
    rot, t = rigid(rotvec, translation)
    smat = np.array([[1, shear[0], shear[1]], [0, 1, shear[2]], [0, 0, 1]])
    return rot @ np.diag(scale) @ smat, t


# name: (3x3 matrix, ITK translation, ITK centre (LPS))
SYNTHETIC = {
    "identity": (np.eye(3), np.zeros(3), np.zeros(3)),
    "rigid-small": (*rigid([0.01, -0.02, 0.015], [0.4, -1.2, 0.8]), np.array([1.5, -12.0, 20.25])),
    "rigid-tiny-angle": (*rigid([2e-4, 1e-4, -3e-4], [0.05, 0.0, -0.02]), np.zeros(3)),
    "rigid-large": (*rigid([0.3, 0.9, -1.2], [5.0, 3.0, -7.0]), np.array([-30.0, 40.0, 10.0])),
    "rigid-near-pi": (*rigid([0.0, 3.0, 0.2], [1.0, 2.0, 3.0]), np.array([0.0, 0.0, 0.0])),
    "affine-shoreline": (
        *affine_part([0.02, 0.01, -0.03], [1.1, -0.6, 2.3], [1.01, 0.985, 1.02], [0.01, -0.02, 0.005]),
        np.array([-3.25, 17.5, -8.0]),
    ),
    "affine-reflection": (
        *affine_part([0.1, -0.2, 0.05], [0.0, 1.0, 0.0], [-1.0, 1.0, 1.0], [0.0, 0.0, 0.0]),
        np.array([10.0, 0.0, -5.0]),
    ),
}

GRIDS = {"oblique-las": oblique_las(), "conformed-lps": conformed_lps()}

SEQUENCES = {
    # Rigid NiFreeze-style series: b0 volumes (b <= 50) carry no transform.
    "rigid": {
        "grid": "oblique-las",
        "columns": "rigid",
        "bvals": [0, 1000, 1000, 5, 2000, 1000, 0, 2000, 3000],
        "dwi": ["rigid-small", "rigid-tiny-angle", "identity", "rigid-large", "ants-double.mat",
                "rigid-near-pi"],
    },
    # SHORELine-style series: every volume has an affine transform.
    "affine": {
        "grid": "conformed-lps",
        "columns": "affine",
        "bvals": None,
        "dwi": ["affine-shoreline", "ants-float.mat", "affine-reflection", "identity"],
    },
}


def write_mat(name, matrix, translation, centre):
    xfm = sitk.AffineTransform(3)
    xfm.SetMatrix([float(v) for v in matrix.reshape(-1)])
    xfm.SetTranslation([float(v) for v in translation])
    xfm.SetCenter([float(v) for v in centre])
    sitk.WriteTransform(xfm, os.path.join(HERE, name))


def world_centre(itk_file, shape, affine):
    """Same matrix as QSIPrep, translation of the world grid centre A·c instead of A[:3,:3]·c."""
    aff = sitk.AffineTransform(sitk.ReadTransform(itk_file))
    mat = np.array(aff.GetMatrix()).reshape(3, 3)
    center = np.array(aff.GetCenter())
    offset = np.array(aff.GetTranslation())
    m_lps = np.eye(4)
    m_lps[:3, :3] = mat
    m_lps[:3, 3] = offset + center - mat @ center
    conv = np.diag([-1.0, -1.0, 1.0, 1.0])
    m_ras = conv @ m_lps @ conv
    w = nb.affines.apply_affine(affine, (np.array(shape) - 1) / 2)
    return (m_ras[:3, :3] @ w + m_ras[:3, 3] - w).tolist(), m_ras.tolist()


def nipype_fd(spm):
    """nipype 1.11.0 FramewiseDisplacement._run_interface, parameter_source="SPM"."""
    mpars = np.asarray(spm)
    diff = mpars[:-1, :6] - mpars[1:, :6]
    diff[:, 3:6] *= 50.0
    fd_res = np.abs(diff).sum(axis=1)
    return [None] + [float(v) for v in fd_res]


def cell(v):
    return "n/a" if v is None or not math.isfinite(v) else repr(float(v))


def tsv(rows, fd, columns):
    names = ["trans_x", "trans_y", "trans_z", "rot_x", "rot_y", "rot_z", "framewise_displacement"]
    if columns == "affine":
        names += ["scale_x", "scale_y", "scale_z"]
    lines = ["\t".join(names)]
    for row, d in zip(rows, fd):
        values = list(row[9:12]) + list(row[6:9]) + [d]
        if columns == "affine":
            values += list(row[0:3])
        lines.append("\t".join(cell(v) for v in values))
    return "\n".join(lines) + "\n"


def main():
    get_ras_motion_params = qsiprep_function()
    for name, (matrix, translation, centre) in SYNTHETIC.items():
        write_mat(f"motion-{name}.mat", matrix, translation, centre)
    files = {name: f"motion-{name}.mat" for name in SYNTHETIC}
    files["ants-double.mat"] = "ants-double.mat"
    files["ants-float.mat"] = "ants-float.mat"

    out = {"grids": {}, "cases": [], "sequences": {}}
    params = {}
    with tempfile.TemporaryDirectory() as tmp:
        for gname, (shape, affine) in GRIDS.items():
            out["grids"][gname] = {"shape": shape, "affine": affine.tolist()}
            ref = os.path.join(tmp, f"{gname}.nii")
            nb.Nifti1Image(np.zeros(shape, dtype=np.uint8), affine).to_filename(ref)
            # nibabel stores the affine in float32 sform; record what QSIPrep reads back.
            out["grids"][gname]["affine"] = nb.load(ref).affine.tolist()
            for key, fname in files.items():
                path = os.path.join(HERE, fname)
                values = get_ras_motion_params(path, ref)
                world, m_ras = world_centre(path, shape, nb.load(ref).affine)
                params[(gname, key)] = values
                out["cases"].append({
                    "grid": gname,
                    "file": fname,
                    "ras": m_ras,
                    "qsiprep": [float(v) for v in values],
                    "world_translation": world,
                })
    for sname, seq in SEQUENCES.items():
        dwi = [params[(seq["grid"], k)] for k in seq["dwi"]]
        identity = np.array([1.0, 1.0, 1.0] + [0.0] * 9)
        if seq["bvals"] is None:
            rows = dwi
        else:
            it = iter(dwi)
            rows = [identity if b <= 50 else next(it) for b in seq["bvals"]]
            if next(it, None) is not None:
                raise RuntimeError(f"{sname}: more transforms than b > 50 volumes")
        spm = [list(r[9:12]) + list(r[6:9]) for r in rows]
        fd = nipype_fd(spm)
        out["sequences"][sname] = {
            "grid": seq["grid"],
            "columns": seq["columns"],
            "bvals": seq["bvals"],
            "dwi": [files[k] for k in seq["dwi"]],
            "framewise_displacement": fd,
            "tsv": tsv(rows, fd, seq["columns"]),
        }
    with open(os.path.join(HERE, "motion.json"), "w") as f:
        json.dump(out, f, indent=1)
        f.write("\n")
    print(f"wrote {len(files) - 2} .mat files and motion.json", file=sys.stderr)


if __name__ == "__main__":
    main()
