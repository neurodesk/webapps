"""Compares OrientationJ maps of the SHG example with the scipy reference (results.json).

    python3 -I compare.py ../scipy-reference.py <example.tif> <folder of OrientationJ outputs>
"""
import importlib.util
import json
import sys

import numpy as np
import tifffile

spec = importlib.util.spec_from_file_location("ref", sys.argv[1])
ref = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ref)
img = tifffile.imread(sys.argv[2]).astype(np.float64)
comps = ref.tensor(img, 1.0, 3.0)
o, c, e = ref.maps2d(*comps)
out = {}
for g, name in [("g4", "Gaussian gradient"), ("g0", "cubic spline gradient")]:
    oo = tifffile.imread(f"{sys.argv[3]}/{g}_4.tif").astype(np.float64)
    cc = tifffile.imread(f"{sys.argv[3]}/{g}_6.tif").astype(np.float64)
    ee = tifffile.imread(f"{sys.argv[3]}/{g}_2.tif").astype(np.float64)
    m = np.zeros_like(c, bool)
    m[16:-16, 16:-16] = True
    sel = m & (c >= 0.2) & (e >= 0.01 * e.max())
    d = ((o - oo + 90) % 180) - 90
    ad = np.abs(d[sel])
    out[name] = {
        "pixels": int(sel.sum()),
        "orientation_abs_diff_deg": {"median": float(np.median(ad)), "p95": float(np.percentile(ad, 95)), "mean": float(ad.mean())},
        "coherency_abs_diff": {"median": float(np.median(np.abs(c - cc)[sel])), "p95": float(np.percentile(np.abs(c - cc)[sel], 95))},
        "energy_correlation": float(np.corrcoef(e[m].ravel(), ee[m].ravel())[0, 1]),
        "energy_ratio_median": float(np.median(ee[sel] / e[sel])),
    }
print(json.dumps(out, indent=1))
