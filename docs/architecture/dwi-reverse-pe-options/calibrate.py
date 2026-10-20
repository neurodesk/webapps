"""Find the sign S that relates topup's field to the sampling displacement.

Usage: calibrate.py <run-dir>

topup's --iout holds its own corrected b0 volumes; the first AP volume is its
reference frame and has no movement. Correct that volume with topup's field
using both signs; the sign whose result matches topup's is S. Writes
<run-dir>/calibration.json and the correlation of each sign.
"""

import json
import sys
from pathlib import Path

import nibabel as nb
import numpy as np
from correct import correct

AXES = "ijk"

run = Path(sys.argv[1])
meta = json.loads((run / "prep" / "prep.json").read_text())
pe = meta["ap"]["pe"]
axis = AXES.index(pe[0])
v = -1.0 if pe.endswith("-") else 1.0
trt = meta["ap"]["trt"]
raw = np.asarray(nb.load(run / "prep" / "topup_in.nii.gz").dataobj, np.float64)[..., 0]
ref = np.asarray(nb.load(run / "topup" / "topup_iout.nii.gz").dataobj, np.float64)[
    ..., 0
]
field = np.asarray(nb.load(run / "topup" / "topup_fout.nii.gz").dataobj, np.float64)
mask = ref > 0.1 * ref.max()
result = {}
for s in (1, -1):
    mine = correct(raw, field, trt, v, axis, s)
    result[str(s)] = float(np.corrcoef(mine[mask], ref[mask])[0, 1])
best = max((1, -1), key=lambda s: result[str(s)])
out = {"S": best, "correlation_by_sign": result}
(run / "calibration.json").write_text(json.dumps(out, indent=2) + "\n")
print(json.dumps(out))
