#!/usr/bin/env python3
"""Writes the b-vector rotation fixtures by running NiFreeze's and QSIPrep's own functions.

The upstream functions are not reimplemented here: the script downloads the pinned source
files, checks their SHA-256, and executes the functions it needs from them.

- NiFreeze 3bcfb00df1e008b4dfeb59c0d63717c335ba0d1e (Apache-2.0): the whole module
  `src/nifreeze/data/dmri/utils.py` is imported (it needs only NumPy), and the motion matrix
  is read with nitransforms as `nifreeze/registration/ants.py:_run_registration` reads it.
  The few lines of `nifreeze/data/dmri/io.py:to_nifti` and `data/dmri/base.py` that drop
  the b0 volumes and write the files are repeated below, with their line numbers.
- QSIPrep 26.1.1 (BSD-3-Clause): `qsiprep/interfaces/gradients.py` imports DIPY, nilearn,
  nipype and scikit-learn, so the functions `concatenate_bvals`, `concatenate_bvecs`,
  `bvec_rotation` and `aattp_rotate_vec` are taken from it by `ast` (with
  `safe_unit_vector` from `qsiprep/utils/misc.py`) and executed unchanged. They shell out to
  `antsApplyTransformsToPoints`; a shim on PATH runs that program from antspyx's library
  (ANTs b53aad349e6767de8e1d99a392f05a82b1bf2373, ITK 5.4.5), whose
  `Examples/antsApplyTransformsToPoints.cxx` is identical to ANTs v2.6.0's, the release
  QSIPrep 26.1.1 pins (pixi.lock: ants-2.6.0, libitk-5.4.6).

Environment (recorded in cases.json): Python 3.12, numpy 2.1.3, antspyx 0.6.3,
nitransforms 25.1.0, nibabel 5.4.2, scipy 1.15.3:

    python3 -m venv venv && venv/bin/pip install numpy==2.1.3 antspyx==0.6.3 nitransforms==25.1.0
    venv/bin/python -I make_bvec_fixtures.py

Inputs are synthetic: random affines (fixed seed) on the ds005577 sub-107 table from the
gradients crate's test data, on a small table with edge cases, and on a 300-volume table
that exercises the single-precision inverse. Real references follow #438.
"""

import ast
import hashlib
import json
import logging
import os
import platform
import re
import shutil
import stat
import struct
import sys
import tempfile
import types
import urllib.request
from importlib.metadata import version
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
GRADIENTS = HERE.parents[3] / "gradients" / "tests" / "data"

NIFREEZE = "3bcfb00df1e008b4dfeb59c0d63717c335ba0d1e"
QSIPREP = "26.1.1"
SOURCES = {
    "nifreeze_utils": (
        f"https://raw.githubusercontent.com/nipreps/nifreeze/{NIFREEZE}/src/nifreeze/data/dmri/utils.py",
        "7d86af7a898a11d9d409220f86b78d3aa2fca5697d0cacff3885fe6d5cfccc03",
    ),
    "qsiprep_gradients": (
        f"https://raw.githubusercontent.com/PennLINC/qsiprep/{QSIPREP}/qsiprep/interfaces/gradients.py",
        "2e92d6c25de3bd76179d2d0de63d53e911fe45b13f3f7e0eedfa3035c320a135",
    ),
    "qsiprep_misc": (
        f"https://raw.githubusercontent.com/PennLINC/qsiprep/{QSIPREP}/qsiprep/utils/misc.py",
        "e57da3dbcf99b2daa9bf016bb31d3ceb04340eab81cf2aa8771dbccfeb8eee73",
    ),
}


def fetch(name):
    url, sha = SOURCES[name]
    data = urllib.request.urlopen(url).read()
    got = hashlib.sha256(data).hexdigest()
    if got != sha:
        sys.exit(f"{url}: sha256 {got}, expected {sha}")
    return data.decode()


def functions(source, names, namespace):
    """Executes the named top-level functions of `source` in `namespace`."""
    tree = ast.parse(source)
    found = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in names]
    if sorted(n.name for n in found) != sorted(names):
        sys.exit(f"missing functions: {names}")
    exec(compile(ast.Module(body=found, type_ignores=[]), "<upstream>", "exec"), namespace)
    return namespace


def fname_presuffix(fname, prefix="", suffix="", newpath=None, use_ext=True):
    """nipype.utils.filemanip.fname_presuffix for the plain names used here."""
    pth, base = os.path.split(fname)
    base, ext = os.path.splitext(base)
    if not use_ext:
        ext = ""
    return os.path.join(newpath or pth, prefix + base + suffix + ext)


def write_mat(path, precision, parameters, fixed):
    """An ITK MATLAB v4 affine as ANTs writes it (little-endian)."""
    kind, fmt = (10, "<f") if precision == "float" else (0, "<d")
    out = b""
    for name, values in ((f"AffineTransform_{precision}_3_3", parameters), ("fixed", fixed)):
        out += struct.pack("<5i", kind, len(values), 1, 0, len(name) + 1) + name.encode() + b"\0"
        out += b"".join(struct.pack(fmt, v) for v in values)
    Path(path).write_bytes(out)


def rotation(axis, angle):
    axis = np.asarray(axis, float) / np.linalg.norm(axis)
    k = np.array([[0, -axis[2], axis[1]], [axis[2], 0, -axis[0]], [-axis[1], axis[0], 0]])
    return np.eye(3) + np.sin(angle) * k + (1 - np.cos(angle)) * k @ k


def transform(rng, precision, max_angle, scale, shear, shift, matrix=None):
    if matrix is None:
        r = rotation(rng.normal(size=3), rng.uniform(-max_angle, max_angle))
        s = np.diag(rng.uniform(1 - scale, 1 + scale, 3))
        h = np.eye(3)
        h[0, 1], h[0, 2], h[1, 2] = rng.uniform(-shear, shear, 3)
        matrix = r @ s @ h
    parameters = list(np.asarray(matrix).ravel()) + list(rng.uniform(-shift, shift, 3))
    fixed = list(rng.uniform(-50, 50, 3))
    if precision == "float":
        parameters = [float(np.float32(v)) for v in parameters]
        fixed = [float(np.float32(v)) for v in fixed]
    return {"precision": precision, "parameters": [float(v) for v in parameters], "fixed": [float(v) for v in fixed]}


def unit(rng):
    v = rng.normal(size=3)
    return v / np.linalg.norm(v)


def text_table(bvals, bvecs):
    """Input files as a scanner would write them: repr of each number."""
    bval = " ".join(repr(float(b)) if b != int(b) else str(int(b)) for b in bvals) + "\n"
    rows = [" ".join(repr(float(v[i])) for v in bvecs) for i in range(3)]
    return bval, "\n".join(rows) + "\n"


def cases():
    rng = np.random.default_rng(442)
    image_affine = np.eye(4)
    image_affine[:3, :3] = rotation([0.2, 1.0, 0.3], 0.12) @ np.diag([-2.0, 2.0, 2.2])
    image_affine[:3, 3] = [118.3, -96.7, -61.4]
    image_affine = [[float(v) for v in row] for row in image_affine]

    out = []
    # ds005577 sub-107: 101 volumes, 11 b0, with moderate motion.
    n = len((GRADIENTS / "sub-107_dir-AP_dwi.bval").read_text().split())
    out.append({
        "name": "ds005577",
        "bval": "../../../../gradients/tests/data/sub-107_dir-AP_dwi.bval",
        "bvec": "../../../../gradients/tests/data/sub-107_dir-AP_dwi.bvec",
        "image_affine": image_affine,
        "transforms": [
            transform(rng, ("float", "double")[i % 2], 0.1, 0.03, 0.02, 3.0) for i in range(n)
        ],
    })

    # Edge cases, one per volume. No volume has an exact identity matrix: NiFreeze's
    # inv(A)·A then leaves residues near 1e-17 whose sign, printed as 0.000000 or -0.000000,
    # depends on the LAPACK and BLAS kernels NumPy runs.
    tiny = rotation([0, 0, 1], 1e-9)
    big = rotation([1.0, -2.0, 0.5], 0.6) @ np.diag([1.08, 0.93, 1.0]) @ np.array(
        [[1, 0.1, 0], [0, 1, -0.05], [0, 0, 1]]
    )
    table = [
        (0, [0, 0, 0], None),               # b0
        (1000, [1, 0, 0], None),
        (1000, [0.6, 0.8, 0], big),          # large rotation with scale and shear
        (1000, [-1e-9, 0, 1], tiny),         # a component that prints as -0
        (2000, [0.5, 0, 0], None),           # NiFreeze: b becomes 1000, direction unit
        (1000, [0, 0, 1.005], None),         # NiFreeze keeps a near-unit direction as it is
        (1000, [0, 0, 0.6], None),           # NiFreeze: b becomes 600, direction unit
        (3000, [-0.267261, 0.534522, 0.801784], None),
        (0, [0, 0, 0], None),
        (150, [0, 0, 1], None),
        (40, [0, 0, 0], None),               # b0 under every rule
    ]
    for b in (1000, 2000, 3000, 1000, 2000):
        table.append((b, list(unit(rng)), None))
    out.append({
        "name": "edges",
        "bval_values": [t[0] for t in table],
        "bvec_values": [t[1] for t in table],
        "image_affine": image_affine,
        "transforms": [
            transform(rng, ("float", "double")[i % 2], 0.2, 0.05, 0.05, 5.0, matrix=t[2])
            for i, t in enumerate(table)
        ],
    })

    # Many large transforms: the float inverse must match ITK's to the bit.
    out.append({
        "name": "stress",
        "bval_values": [1000] * 300,
        "bvec_values": [list(unit(rng)) for _ in range(300)],
        "image_affine": image_affine,
        "transforms": [
            transform(rng, ("float", "double")[i % 2], 0.5, 0.2, 0.1, 10.0) for i in range(300)
        ],
    })
    return out


def ants_shim(bindir):
    """`antsApplyTransformsToPoints` on PATH, run from antspyx's library."""
    shim = Path(bindir) / "antsApplyTransformsToPoints"
    shim.write_text(
        f"#!{sys.executable} -I\n"
        "import sys\n"
        "from ants.internal import get_lib_fn\n"
        "sys.exit(get_lib_fn('antsApplyTransformsToPoints')(sys.argv[1:]))\n"
    )
    shim.chmod(shim.stat().st_mode | stat.S_IXUSR)


def main():
    os.environ.setdefault("MPLCONFIGDIR", tempfile.mkdtemp())
    import nitransforms as nt

    nf = types.ModuleType("nifreeze_utils")
    exec(compile(fetch("nifreeze_utils"), "nifreeze/data/dmri/utils.py", "exec"), nf.__dict__)

    qsi = {"np": np, "os": os, "LOGGER": logging.getLogger("qsiprep"), "fname_presuffix": fname_presuffix}
    functions(fetch("qsiprep_misc"), ["safe_unit_vector"], qsi)
    functions(
        fetch("qsiprep_gradients"),
        ["concatenate_bvals", "concatenate_bvecs", "bvec_rotation", "aattp_rotate_vec"],
        qsi,
    )

    work = Path(tempfile.mkdtemp())
    ants_shim(work)
    os.environ["PATH"] = f"{work}{os.pathsep}{os.environ['PATH']}"

    all_cases = cases()
    for case in all_cases:
        name = case["name"]
        if "bval" in case:
            bval_file = HERE / case["bval"]
            bvec_file = HERE / case["bvec"]
        else:
            bval_text, bvec_text = text_table(case.pop("bval_values"), case.pop("bvec_values"))
            (HERE / f"{name}.bval").write_text(bval_text)
            (HERE / f"{name}.bvec").write_text(bvec_text)
            case["bval"], case["bvec"] = f"{name}.bval", f"{name}.bvec"
            bval_file, bvec_file = HERE / case["bval"], HERE / case["bvec"]
        mats = []
        for i, t in enumerate(case["transforms"]):
            mats.append(str(work / f"{name}-{i:05d}.mat"))
            write_mat(mats[-1], t["precision"], t["parameters"], t["fixed"])

        # NiFreeze: io.py:105-110 reads the files as float32; DWI(gradients=...) formats them
        # (base.py:129, converter=format_gradients) and drops b <= DEFAULT_LOWB_THRESHOLD
        # (base.py:158-181); the motion is nitransforms' RAS matrix (ants.py:497-500).
        bvecs = np.loadtxt(bvec_file, dtype="float32")
        if bvecs.shape[1] != 3 and bvecs.shape[0] == 3:
            bvecs = bvecs.T
        bvals = np.loadtxt(bval_file, dtype="float32")
        gradients = nf.format_gradients(np.column_stack((bvecs, bvals)))
        keep = ~(gradients[:, -1] <= nf.DEFAULT_LOWB_THRESHOLD)
        gradients = gradients[keep]
        affines = [
            nt.linear.Affine(nt.io.itk.ITKLinearTransform.from_filename(m).to_ras()).matrix
            for m, k in zip(mats, keep) if k
        ]
        imaffine = np.array(case["image_affine"])
        # io.py:186-191 and 233-234.
        rotated = [
            nf.transform_fsl_bvec(bvec, affine, imaffine, invert=True)
            for bvec, affine in zip(gradients[:, :3], affines, strict=True)
        ]
        np.savetxt(HERE / f"{name}.nifreeze.bvec", np.asarray(rotated).T, fmt="%.6f")
        np.savetxt(HERE / f"{name}.nifreeze.bval", gradients[:, -1][np.newaxis, :], fmt="%.2f")

        # QSIPrep: GradientRotation._run_interface (gradients.py:768-779) on the whole table.
        runtime = types.SimpleNamespace(cwd=str(work))
        qsi["concatenate_bvals"]([str(bval_file)], str(HERE / f"{name}.shoreline.bval"))
        table = qsi["concatenate_bvecs"]([str(bvec_file)])
        qsi["bvec_rotation"](table, mats, str(HERE / f"{name}.shoreline.bvec"), runtime)

    provenance = {
        "nifreeze": NIFREEZE,
        "qsiprep": QSIPREP,
        "python": platform.python_version(),
        "numpy": version("numpy"),
        "antspyx": version("antspyx"),
        "nitransforms": version("nitransforms"),
        "nibabel": version("nibabel"),
        "scipy": version("scipy"),
        "machine": platform.machine(),
    }
    # One line per transform keeps the file small and its diffs readable.
    text = json.dumps({"provenance": provenance, "cases": all_cases}, indent=1)
    text = re.sub(r"\[\s+([^\[\]{}]*?)\s+\]", lambda m: "[" + " ".join(m.group(1).split()) + "]", text)
    (HERE / "cases.json").write_text(text + "\n")
    shutil.rmtree(work)


if __name__ == "__main__":
    main()
