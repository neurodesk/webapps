"""Write tests/fixtures/topup.json: topup coefficient files and the fields topup evaluates
from them, on two synthetic AP/PA b0 pairs. FSL is a reference tool here, never ported.

    python -I tools/topup_reference.py WORK_DIR tests/fixtures/topup.json

Needs FSL's `topup` on PATH (FSLDIR set) and numpy, scipy and nibabel. Each case distorts a
synthetic image with a known field, runs topup with a short two-level schedule, and stores:
the coefficient grid and knot spacing (`--out` ... `_fieldcoef`), the field topup writes on the
image grid (`--fout`, Hz), the true field, the image affine and the datain rows. Arrays are
flattened in NIfTI order (x fastest).

Case A has a negative-determinant (radiological) affine, phase encoding along j and a knot
spacing of 2 voxels; case B has a positive-determinant affine, for which FSL reverses the x
voxel axis, phase encoding along i and a knot spacing of 3 voxels. Cases C and D repeat
those geometries with a knot spacing of 1 voxel (N coefficients per axis)."""

import json
import os
import subprocess
import sys

import nibabel as nb
import numpy as np
from scipy.ndimage import map_coordinates

work, out = sys.argv[1], sys.argv[2]
os.makedirs(work, exist_ok=True)
fsldir = os.environ["FSLDIR"]
with open(os.path.join(fsldir, "etc", "fslversion")) as f:
    fsl_version = f.read().strip()

READOUT = 0.05
SCHEDULE = """--warpres={coarse},{fine}
--subsamp=1,1
--fwhm=4,0
--miter=5,5
--lambda=0.001,0.00001
--ssqlambda=1
--regmod=bending_energy
--estmov=0,0
--minmet=1,1
--splineorder=3
--numprec=double
--interp=spline
--scale=1
"""


def true_field(shape, axis):
    g = np.meshgrid(*[np.linspace(-1, 1, n) for n in shape], indexing="ij")
    return 40 * np.exp(-((g[0] - 0.2) ** 2 + (g[1] + 0.3) ** 2 + g[2] ** 2) / 0.3) - 15 * g[axis]


def case(name, shape, determinant, axis, knot_mm):
    rng = np.random.default_rng(7)
    affine = np.diag([2.0, 2.0, 2.0, 1.0])
    affine[:3, 3] = -np.array(shape, float) + 1
    if determinant < 0:
        affine[0, 0] = -2.0
        affine[0, 3] = shape[0] - 1
    g = np.meshgrid(*[np.linspace(-1, 1, n) for n in shape], indexing="ij")
    image = 1000 * np.exp(-(g[0] ** 2 + g[1] ** 2 + 1.5 * g[2] ** 2) / 0.4)
    for _ in range(12):
        c = rng.uniform(-0.6, 0.6, 3)
        image += 300 * np.exp(-((g[0] - c[0]) ** 2 + (g[1] - c[1]) ** 2 + (g[2] - c[2]) ** 2) / 0.02)
    field = true_field(shape, axis)
    # Signal at voxel y appears at y + sign * field * readout along the file's voxel axis.
    coords = np.indices(shape).astype(float)
    volumes = []
    for sign in (1, -1):
        c = coords.copy()
        c[axis] -= sign * field * READOUT
        volumes.append(map_coordinates(image, c, order=3, mode="nearest"))
    pair = os.path.join(work, f"{name}_pair.nii.gz")
    nb.Nifti1Image(np.stack(volumes, -1).astype(np.float32), affine).to_filename(pair)
    # datain vectors are in FSL's voxel axes, which reverse x for a positive determinant.
    fsl_sign = -1 if (determinant > 0 and axis == 0) else 1
    rows = []
    for sign in (1, -1):
        v = [0, 0, 0]
        v[axis] = sign * fsl_sign
        rows.append(v + [READOUT])
    datain = os.path.join(work, f"{name}_acq.txt")
    with open(datain, "w") as f:
        f.writelines(" ".join(str(x) for x in r) + "\n" for r in rows)
    config = os.path.join(work, f"{name}.cnf")
    with open(config, "w") as f:
        f.write(SCHEDULE.format(coarse=2 * knot_mm, fine=knot_mm))
    base = os.path.join(work, f"{name}_topup")
    fout = os.path.join(work, f"{name}_fout")
    subprocess.run(["topup", f"--imain={pair}", f"--datain={datain}", f"--config={config}", f"--out={base}", f"--fout={fout}"], check=True)
    coef = nb.load(base + "_fieldcoef.nii.gz")
    hz = nb.load(fout + ".nii.gz")
    # The shortest decimal that reads back as the same float32 value.
    flat = lambda a: [float(repr(x)) for x in np.asarray(a, np.float32).ravel(order="F")]
    return {
        "name": name,
        "dims": list(shape),
        "affine": affine.tolist(),
        "datain": rows,
        "coef_dims": list(coef.shape[:3]),
        "knot_spacing": [float(z) for z in coef.header.get_zooms()[:3]],
        "intent_code": int(coef.header["intent_code"]),
        "coefficients": flat(coef.get_fdata()),
        "fout": flat(hz.get_fdata().squeeze()),
        "true_field": flat(field),
    }


cases = [
    case("A", (19, 15, 11), -1, 1, 4),
    case("B", (16, 14, 10), 1, 0, 6),
    # A warp resolution as fine as the voxels: knot spacing 1, N coefficients per axis.
    case("C", (17, 15, 11), -1, 1, 2),
    case("D", (16, 14, 10), 1, 0, 2),
]
with open(out, "w") as f:
    json.dump({"fsl": fsl_version, "readout_time": READOUT, "cases": cases}, f, separators=(",", ":"))
    f.write("\n")
