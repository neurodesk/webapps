"""Compare two DR-BUDDI results field by field (native/WebAssembly parity).

Usage: compare_fields.py RPE_SCRIPTS RUN_DIR A_DIR B_DIR [A_FIELD_HZ B_FIELD_HZ]

RUN_DIR is a #471 run directory (prep/, mask/, calibration.json). A_DIR and
B_DIR each hold up.nii (FINV) and down.nii (MINV), or are both "-" to compare
only the final fields (for a reference that has no up and down fields). Each
field's PE component goes to Hz on the AP b0 grid with fields.py's conversion.
The optional field_hz.nii.gz files are the final fields that post.sh scores.
Prints JSON: max, median and 99th percentile of |A - B| in Hz in the brain
mask, and the largest absolute difference of any vector component in mm over
the volume (only when both fields share one grid).
"""

import hashlib
import json
import sys
from pathlib import Path

import nibabel as nb
import numpy as np

sys.path.insert(0, sys.argv[1])
from fields import AXES, load_field, lps_to_ras, on_grid, pe_voxels


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def stats(diff):
    a = np.abs(diff)
    return {
        "max_hz": float(a.max()),
        "median_hz": float(np.median(a)),
        "p99_hz": float(np.percentile(a, 99)),
    }


def main(scripts, run, a_dir, b_dir, *finals):
    run = Path(run)
    meta = json.loads((run / "prep" / "prep.json").read_text())
    cal = json.loads((run / "calibration.json").read_text())
    target = nb.load(run / "prep" / "ap_mean.nii.gz")
    mask = np.asarray(nb.load(run / "mask" / "b0_mask.nii.gz").dataobj) > 0.5
    pe = meta["ap"]["pe"]
    axis = AXES.index(pe[0])
    v_ap = -1.0 if pe.endswith("-") else 1.0
    scale = 1.0 / (cal["S"] * meta["ap"]["trt"] * v_ap)
    out = {"voxels": int(mask.sum())}
    names = () if a_dir == b_dir == "-" else ("up", "down")
    if not names and not finals:
        sys.exit(
            "compare_fields.py: with A_DIR and B_DIR '-', give both field_hz files"
        )
    for name in names:
        pa, pb = Path(a_dir, f"{name}.nii"), Path(b_dir, f"{name}.nii")
        ia, wa = load_field(pa)
        ib, wb = load_field(pb)
        ha = pe_voxels(on_grid(ia, lps_to_ras(wa), target), target, axis) * scale
        hb = pe_voxels(on_grid(ib, lps_to_ras(wb), target), target, axis) * scale
        out[name] = {
            **stats((ha - hb)[mask]),
            "max_abs_mm_any_component": (
                float(np.abs(wa - wb).max()) if wa.shape == wb.shape else None
            ),
            "byte_identical": sha(pa) == sha(pb),
        }
    if finals:
        fa = np.asarray(nb.load(finals[0]).dataobj, np.float64)
        fb = np.asarray(nb.load(finals[1]).dataobj, np.float64)
        out["final_field_hz"] = stats((fa - fb)[mask])
    print(json.dumps(out, indent=2))


if __name__ == "__main__":
    main(*sys.argv[1:])
