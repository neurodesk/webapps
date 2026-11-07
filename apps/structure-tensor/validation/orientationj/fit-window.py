"""Finds the sigma and rho of this app's tensor that best match OrientationJ's maps of the SHG example.

OrientationJ ran with tensor=3 and its Gaussian gradient (example.ijm, outputs g4_4.tif
orientation and g4_6.tif coherency). This recomputes the app's tensor with the scipy reference
over a grid of scales and reports the orientation difference on the pixels compare.py uses
(16 or more from the border, coherency >= 0.2 and energy >= 1% of max at sigma 1, rho 3).

    python3 -I fit-window.py ../scipy-reference.py <example.tif> <folder of OrientationJ outputs>
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
oj_orientation = tifffile.imread(f"{sys.argv[3]}/g4_4.tif").astype(np.float64)
oj_coherency = tifffile.imread(f"{sys.argv[3]}/g4_6.tif").astype(np.float64)
inner = np.zeros(img.shape, bool)
inner[16:-16, 16:-16] = True
_, c0, e0 = ref.maps2d(*ref.tensor(img, 1.0, 3.0))
sel = inner & (c0 >= 0.2) & (e0 >= 0.01 * e0.max())
rows = []
for sigma in [0.75, 0.9, 1.0, 1.1, 1.25, 1.5]:
    for rho in [2.5, 3.0, 3.5, 4.0, 4.5, 4.8, 4.9, 5.0, 5.1, 5.2, 5.3, 5.5, 6.0]:
        o, c, _ = ref.maps2d(*ref.tensor(img, sigma, rho))
        d = np.abs(((o - oj_orientation + 90) % 180) - 90)[sel]
        rows.append({
            "sigma": sigma,
            "rho": rho,
            "orientationMedianDeg": round(float(np.median(d)), 4),
            "orientationP95Deg": round(float(np.percentile(d, 95)), 4),
            "coherencyMedian": round(float(np.median(np.abs(c - oj_coherency)[sel])), 5),
        })
rows.sort(key=lambda row: row["orientationMedianDeg"])
print(json.dumps({"pixels": int(sel.sum()), "best": rows[:5], "appDefault": next(r for r in rows if r["sigma"] == 1.0 and r["rho"] == 3.0)}, indent=1))
