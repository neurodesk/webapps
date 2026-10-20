"""Make the ITK .mat fixtures for the hmc crate with a real antsRegistration.

The fixtures are committed, so `cargo test` needs no Python. Rerun only to remake them:

    python -m venv venv
    venv/bin/pip install antspyx==0.6.3 nitransforms==25.1.0
    venv/bin/python make_fixtures.py            # writes ants-double.mat, ants-float.mat, expected.json
    venv/bin/python make_fixtures.py --expected # rewrites only expected.json from the committed files
    venv/bin/python make_fixtures.py --check F  # reads a .mat written by the crate with ANTs and nitransforms

Recorded with antspyx 0.6.3 (ANTs v2.5.1.post95-g2236a75), nitransforms 25.1.0, numpy 2.3.5.
Each file is the 0GenericAffine.mat of a mean-squares affine registration of two synthetic volumes:
`singleprecision=True` passes `--float 1` (AffineTransform_float_3_3, as the WebAssembly build
writes), `False` passes `--float 0` (AffineTransform_double_3_3, as native double runs write).
expected.json holds each file's parameters and fixed centre as scipy and nitransforms read them,
the LPS matrix (fixed point to moving point) and the RAS matrix by nitransforms' composition, and
nitransforms' own `to_ras()` (see `nitransforms_reading`).
"""

import json
import os
import shutil
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
NAMES = ("ants-double.mat", "ants-float.mat")


def nitransforms_reading(path):
    """The file's values, and the matrices by nitransforms' composition.

    nitransforms 25.1.0 holds the fixed centre as float32 (`ITKLinearTransform`'s `offset`
    field), which moves a double file's matrices by up to about 4e-9. `lps` and `ras` therefore
    use nitransforms' own formula (`to_ras`) with the file's centre at full precision;
    `nitransforms_ras` is `to_ras()` itself, with the float32 centre.
    """
    from nitransforms.io.itk import ITKLinearTransform
    from nitransforms.io.itk import LPS
    from scipy.io import loadmat
    from nibabel.affines import from_matvec

    xfm = ITKLinearTransform.from_filename(path)
    matrix = np.array(xfm.structarr["parameters"], dtype=np.float64)
    mdict = loadmat(path)
    name = next(k for k in mdict if k.startswith("AffineTransform_"))
    params = np.asarray(mdict[name], dtype=np.float64).reshape(-1)
    centre = np.asarray(mdict["fixed"], dtype=np.float64).reshape(-1)
    if not np.array_equal(params[:9].reshape(3, 3), matrix[:3, :3]) or not np.array_equal(
        params[9:], matrix[:3, 3]
    ):
        raise RuntimeError("nitransforms and scipy read different parameters")
    c_neg = from_matvec(np.eye(3), centre * -1.0)
    c_pos = from_matvec(np.eye(3), centre)
    lps = c_pos.dot(matrix.dot(c_neg))
    ras = LPS.dot(c_pos.dot(matrix.dot(c_neg.dot(LPS))))
    return {
        "name": name,
        "parameters": [float(v) for v in params],
        "fixed": [float(v) for v in centre],
        "lps": [[float(v) for v in row] for row in lps],
        "ras": [[float(v) for v in row] for row in ras],
        "nitransforms_ras": [[float(v) for v in row] for row in np.asarray(xfm.to_ras(), dtype=np.float64)],
    }


def synthetic_pair(ants):
    n = 40
    grid = np.mgrid[0:n, 0:n, 0:n].astype(np.float64)
    centre = np.array([18.0, 21.0, 19.0])
    radii = np.array([9.0, 12.0, 7.0])
    dist = sum(((grid[i] - centre[i]) / radii[i]) ** 2 for i in range(3))
    blob = np.exp(-2.0 * dist) + 0.6 * np.exp(-8.0 * sum(((grid[i] - centre[i] - 5.0) / 4.0) ** 2 for i in range(3)))
    fixed = ants.from_numpy(
        blob.astype(np.float32),
        origin=(-38.0, -42.0, -20.0),
        spacing=(2.0, 2.0, 2.2),
        direction=np.eye(3),
    )
    angle = np.deg2rad(4.0)
    rot = np.array(
        [[np.cos(angle), -np.sin(angle), 0.0], [np.sin(angle), np.cos(angle), 0.0], [0.0, 0.0, 1.0]]
    )
    rot = rot @ np.diag([1.03, 0.98, 1.01])
    truth = ants.create_ants_transform(
        transform_type="AffineTransform",
        precision="double",
        dimension=3,
        matrix=rot,
        translation=(1.5, -2.0, 0.8),
        center=tuple(ants.get_center_of_mass(fixed)),
    )
    moving = truth.apply_to_image(fixed, reference=fixed, interpolation="linear")
    return fixed, moving


def make():
    import ants

    fixed, moving = synthetic_pair(ants)
    for name, single in (("ants-double.mat", False), ("ants-float.mat", True)):
        reg = ants.registration(
            fixed=fixed,
            moving=moving,
            type_of_transform="Affine",
            aff_metric="meansquares",
            singleprecision=single,
            random_seed=1234,
        )
        mats = [p for p in reg["fwdtransforms"] if p.endswith("GenericAffine.mat")]
        if len(mats) != 1:
            raise RuntimeError(f"expected one affine, got {reg['fwdtransforms']}")
        out = os.path.join(HERE, name)
        shutil.copyfile(mats[0], out)
    write_expected()


def write_expected():
    expected = {name: nitransforms_reading(os.path.join(HERE, name)) for name in NAMES}
    with open(os.path.join(HERE, "expected.json"), "w") as f:
        json.dump(expected, f, indent=2)
        f.write("\n")


def check(path):
    """Reads a .mat with ANTs and nitransforms, and has ANTs write it back.

    antspyx 0.6.3 returns `parameters` and `fixed_parameters` as float32 whatever the file's
    precision, and `write_transform` always writes AffineTransform_double_3_3, so a double file
    must come back byte for byte and a float file must come back with the same values.
    """
    import tempfile

    import ants

    reading = nitransforms_reading(path)
    # antspyx reads as float unless told otherwise.
    precision = "float" if reading["name"].endswith("_float_3_3") else "double"
    tx = ants.read_transform(path, precision=precision)
    print("ANTs:", tx.type, tx.precision)
    print("nitransforms:", reading["name"], reading["parameters"], reading["fixed"])
    if tx.type != "AffineTransform" or tx.precision != precision:
        raise SystemExit("ANTs reads a different transform type")
    as_f32 = lambda v: np.asarray(v, dtype=np.float32).astype(np.float64)
    if not np.array_equal(as_f32(tx.parameters), as_f32(reading["parameters"])):
        raise SystemExit("ANTs and nitransforms read different parameters")
    if not np.array_equal(as_f32(tx.fixed_parameters), as_f32(reading["fixed"])):
        raise SystemExit("ANTs and nitransforms read different centres")
    with tempfile.TemporaryDirectory() as tmp:
        again = os.path.join(tmp, "again.mat")
        ants.write_transform(tx, again)
        if precision == "double":
            with open(path, "rb") as a, open(again, "rb") as b:
                if a.read() != b.read():
                    raise SystemExit("ANTs writes the transform back differently")
            print("ANTs writes the same bytes back")
        else:
            back = nitransforms_reading(again)
            if back["parameters"] != reading["parameters"] or back["fixed"] != reading["fixed"]:
                raise SystemExit("ANTs writes different values back")
            print("ANTs writes the same values back (as double)")


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--check":
        check(sys.argv[2])
    elif len(sys.argv) == 2 and sys.argv[1] == "--expected":
        write_expected()
    else:
        make()
