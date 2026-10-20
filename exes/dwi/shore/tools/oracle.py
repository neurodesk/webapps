"""Write tests/fixtures/*.json from QSIPrep 26.1.1's own 3dSHORE code, for tests/oracle.rs.

    python -I tools/oracle.py QSIPREP_CHECKOUT OUT_DIR

QSIPREP_CHECKOUT is a clone of PennLINC/qsiprep at tag 26.1.1. The script loads
qsiprep/utils/shm.py and qsiprep/utils/brainsuite_shore.py unchanged, and takes
_nonoverlapping_qspace_samples unchanged from qsiprep/interfaces/shoreline.py, so it needs
neither nipype nor the rest of QSIPrep. `predict.json` repeats the 3dSHORE branch of
SignalPrediction._run_interface (shoreline.py:166-211) line for line on synthetic data.

Use the QSIPrep 26.1.1 container's numerical stack (its pixi.lock): Python 3.11, numpy 1.26.4
on netlib LAPACK 3.11, scipy 1.11.4, dipy 1.12.1, scikit-learn 1.4.0. The output is
deterministic; a rerun writes the same bytes."""

import ast
import hashlib
import importlib.util
import json
import os
import subprocess
import sys
import types

import dipy
import numpy as np
import scipy
import sklearn
from dipy.core.gradients import gradient_table

src, out = sys.argv[1], sys.argv[2]
utils = os.path.join(src, "qsiprep", "utils")
shoreline_py = os.path.join(src, "qsiprep", "interfaces", "shoreline.py")

# Load shm.py and brainsuite_shore.py as a package, so the relative import works.
package = types.ModuleType("qsiprep_utils")
package.__path__ = [utils]
sys.modules["qsiprep_utils"] = package
for name in ("shm", "brainsuite_shore"):
    spec = importlib.util.spec_from_file_location(f"qsiprep_utils.{name}", os.path.join(utils, f"{name}.py"))
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
bs = sys.modules["qsiprep_utils.brainsuite_shore"]
BrainSuiteShoreModel = bs.BrainSuiteShoreModel
brainsuite_shore_basis = bs.brainsuite_shore_basis

tree = ast.parse(open(shoreline_py).read())
function = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "_nonoverlapping_qspace_samples")
namespace = {"np": np}
exec(compile(ast.Module([function], []), shoreline_py, "exec"), namespace)
_nonoverlapping_qspace_samples = namespace["_nonoverlapping_qspace_samples"]


def sha256(path):
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


provenance = {
    "qsiprep_commit": subprocess.run(["git", "-C", src, "rev-parse", "HEAD"], capture_output=True, text=True, check=True).stdout.strip(),
    "sha256": {
        "brainsuite_shore.py": sha256(os.path.join(utils, "brainsuite_shore.py")),
        "shm.py": sha256(os.path.join(utils, "shm.py")),
        "shoreline.py": sha256(shoreline_py),
    },
    "python": sys.version.split()[0],
    "numpy": np.__version__,
    "scipy": scipy.__version__,
    "dipy": dipy.__version__,
    "scikit-learn": sklearn.__version__,
}


def write(name, payload):
    payload = {"provenance": provenance, **payload}
    with open(os.path.join(out, name), "w") as f:
        json.dump(payload, f, separators=(",", ":"))
        f.write("\n")


def unit(v):
    v = np.asarray(v, float)
    return v / np.linalg.norm(v)


rng = np.random.default_rng(456)


def directions(n):
    v = rng.normal(size=(n, 3))
    return v / np.linalg.norm(v, axis=1)[:, None]


# 1. Basis: b0 rows (zero direction, unit direction at b <= 50, b just above 50), the axes,
# an antipodal pair, a direction 0.5 % longer than unit, and four shells.
rows_b = [0.0, 5.0, 40.0, 60.0, 1000.0, 1000.0, 1000.0, 1000.0, 1000.0, 1000.0, 2000.0]
rows_g = [[0, 0, 0], unit([1, 2, 3]), [0, 0, 0], unit([0.3, -0.5, 0.8]), [0, 0, 1], [0, 0, -1], [1, 0, 0], [0, 1, 0],
          unit([0.2, 0.4, -0.9]), (-unit([0.2, 0.4, -0.9])).tolist(), (1.005 * unit([-0.6, 0.1, 0.4])).tolist()]
for b, n in ((500.0, 6), (1000.0, 8), (2000.0, 8), (3000.0, 8)):
    rows_b += [b] * n
    rows_g += directions(n).tolist()
gtab = gradient_table(bvals=np.array(rows_b), bvecs=np.array(rows_g, float))
basis = brainsuite_shore_basis(6, 700, gtab, 1.0 / (4 * np.pi**2))
write("basis.json", {
    "bvals": rows_b,
    "bvecs": [list(map(float, g)) for g in rows_g],
    "index": bs.shore_index_matrix(6).tolist(),
    "basis": basis.tolist(),
})

# A small two-shell scheme like ds005577's (b = 1000 and 3000, one third and two thirds), with
# an antipodal pair, used by the leave-out and prediction fixtures.
bvals = np.r_[np.full(12, 1000.0), np.full(20, 3000.0)]
bvecs = np.vstack([directions(12), directions(20)])
bvecs[5] = -bvecs[3]
all_bvals = np.array([0.0] + bvals.tolist())
all_bvecs = np.row_stack([np.zeros(3)] + bvecs.tolist())

# 2. Leave-neighbourhood-out masks for every target.
write("leaveout.json", {
    "bvals": bvals.tolist(),
    "bvecs": bvecs.tolist(),
    "cutoff": 2.0,
    "keep": [_nonoverlapping_qspace_samples(bvals[t], bvecs[t], all_bvals, all_bvecs, 2.0).tolist() for t in range(len(bvals))],
})

# 3. Predictions: a 6 x 5 x 4 volume of crossing fibres with noise, float32 as
# quick_load_images loads it. The mask image has zeros, a value below 1e-6 and fractions.
shape = (6, 5, 4)
nvox = int(np.prod(shape))
s0 = rng.uniform(800, 1200, size=nvox)
f1 = directions(nvox)
f2 = directions(nvox)
frac = rng.uniform(0.3, 0.7, size=nvox)


def signal(b, g):
    c1 = (f1 @ g) ** 2
    c2 = (f2 @ g) ** 2
    d1 = 0.3e-3 + 1.4e-3 * c1
    d2 = 0.3e-3 + 1.4e-3 * c2
    s = s0 * (frac * np.exp(-b * d1) + (1 - frac) * np.exp(-b * d2) * 0.8 + 0.2 * (1 - frac) * np.exp(-b * 3e-3))
    return np.abs(s + rng.normal(scale=15.0, size=nvox))


b0_mean = np.mean([signal(0.0, np.zeros(3)) for _ in range(6)], axis=0).astype(np.float32).reshape(shape)
dwis = np.stack([signal(b, g) for b, g in zip(bvals, bvecs)], -1).astype(np.float32).reshape(shape + (len(bvals),))
mask_image = np.ones(nvox)
mask_image[rng.choice(nvox, 30, replace=False)] = 0.0
mask_image[:5] = [5e-7, 0.25, 2.0, 0.0, 1e-6]
mask_image = mask_image.reshape(shape)

predictions = []
weights = []
ranks = []
for t in range(len(bvals)):
    pred_vec = bvecs[t]
    pred_val = bvals[t]
    # shoreline.py:166-211, the 3dshore branch of SignalPrediction._run_interface.
    mask_array = mask_image > 1e-6
    training_mask = _nonoverlapping_qspace_samples(pred_val, pred_vec, all_bvals, all_bvecs, 2.0)
    training_indices = np.flatnonzero(training_mask[1:])
    training_data = np.concatenate([b0_mean[..., None], dwis[..., training_indices]], -1)
    training_gtab = gradient_table(bvals=all_bvals[training_mask], bvecs=all_bvecs[training_mask])
    prediction_bvecs = np.tile(pred_vec, (10, 1))
    prediction_bvals = np.ones(10) * pred_val
    prediction_bvals[9] = 0
    prediction_gtab = gradient_table(bvals=prediction_bvals, bvecs=prediction_bvecs)
    shore_model = BrainSuiteShoreModel(training_gtab, regularization="L2")
    shore_fit = shore_model.fit(training_data, mask=mask_array)
    prediction_shore = brainsuite_shore_basis(shore_model.radial_order, shore_model.zeta, prediction_gtab, shore_model.tau)
    prediction_dir = prediction_shore[0]
    shore_array = shore_fit._shore_coef[mask_array]
    output_data = np.zeros(mask_array.shape)
    output_data[mask_array] = np.dot(shore_array, prediction_dir)
    predictions.append(output_data.ravel().tolist())
    # The per-target weights the port computes, from the model's cached solve.
    pinv = shore_model.cache_get("shore_matrix_reg_pinv", key=training_gtab)
    weights.append({"volumes": training_indices.tolist(), "weights": (prediction_dir @ pinv).tolist()})
    ranks.append(int(np.linalg.matrix_rank(shore_model.cache_get("shore_matrix", key=training_gtab))))

write("predict.json", {
    "shape": list(shape),
    "bvals": bvals.tolist(),
    "bvecs": bvecs.tolist(),
    "mask": mask_image.ravel().tolist(),
    "b0_mean": b0_mean.ravel().astype(float).tolist(),
    "dwis": [dwis[..., i].ravel().astype(float).tolist() for i in range(len(bvals))],
    "predictions": predictions,
    "weights": weights,
    "basis_rank": ranks,
})
