"""Gate and report metrics for one method's field on one subject.

Usage: evaluate.py <run-dir> <method>

Inputs: prep/ap_mean, prep/pa_mean_reg, <method>/field_hz, mask/b0_mask,
topup/field_hz and, when present, gre/gre_hz_on_ap. Writes
<method>/metrics.json and <method>/corrected_mean.nii.gz (for the BBR cost).

- appa_mad: mean |AP - PA| over the brain after correction, divided by the
  mean of the corrected mean b0 (gate: at most 1.1 x topup's).
- appa_1mncc: 1 - Pearson correlation of corrected AP and PA in the brain.
- appa_mad_nojac: appa_mad without Jacobian modulation (reported only).
- field_vs_topup_mad_hz, field_vs_gre_mad_hz: median absolute difference in
  the brain.
- field_vs_topup_mad_demeaned_hz: the same after removing the median offset.
  A constant field is a translation along the PE axis, which the rigid PA-to-AP
  alignment and topup's movement model each absorb in part.
"""

import json
import sys
from pathlib import Path

import nibabel as nb
import numpy as np
from correct import correct

AXES = "ijk"


def load(path):
    return np.asarray(nb.load(path).dataobj, np.float64)


def main(run, method):
    run = Path(run)
    meta = json.loads((run / "prep" / "prep.json").read_text())
    s = json.loads((run / "calibration.json").read_text())["S"]
    axis = AXES.index(meta["ap"]["pe"][0])
    v_ap = -1.0 if meta["ap"]["pe"].endswith("-") else 1.0
    v_pa = -1.0 if meta["pa"]["pe"].endswith("-") else 1.0
    ap_img = nb.load(run / "prep" / "ap_mean.nii.gz")
    ap = load(run / "prep" / "ap_mean.nii.gz")
    pa = load(run / "prep" / "pa_mean_reg.nii.gz")
    mask = load(run / "mask" / "b0_mask.nii.gz") > 0.5
    f = load(run / method / "field_hz.nii.gz")
    c_ap = correct(ap, f, meta["ap"]["trt"], v_ap, axis, s)
    c_pa = correct(pa, f, meta["pa"]["trt"], v_pa, axis, s)
    mean = 0.5 * (c_ap + c_pa)
    nb.Nifti1Image(mean.astype(np.float32), ap_img.affine).to_filename(
        run / method / "corrected_mean.nii.gz"
    )
    for name, data in (("corrected_ap", c_ap), ("corrected_pa", c_pa)):
        nb.Nifti1Image(data.astype(np.float32), ap_img.affine).to_filename(
            run / method / f"{name}.nii.gz"
        )
    a, b = c_ap[mask], c_pa[mask]
    metrics = {
        "method": method,
        "voxels": int(mask.sum()),
        "appa_mad": float(np.mean(np.abs(a - b)) / np.mean(0.5 * (a + b))),
        "appa_1mncc": float(1.0 - np.corrcoef(a, b)[0, 1]),
        "uncorrected_appa_mad": float(
            np.mean(np.abs(ap[mask] - pa[mask])) / np.mean(0.5 * (ap[mask] + pa[mask]))
        ),
        "field_median_abs_hz": float(np.median(np.abs(f[mask]))),
    }
    n_ap = correct(ap, f, meta["ap"]["trt"], v_ap, axis, s, jacobian=False)[mask]
    n_pa = correct(pa, f, meta["pa"]["trt"], v_pa, axis, s, jacobian=False)[mask]
    metrics["appa_mad_nojac"] = float(
        np.mean(np.abs(n_ap - n_pa)) / np.mean(0.5 * (n_ap + n_pa))
    )
    topup = load(run / "topup" / "field_hz.nii.gz")
    metrics["field_vs_topup_mad_hz"] = float(np.median(np.abs(f[mask] - topup[mask])))
    metrics["field_vs_topup_r"] = float(np.corrcoef(f[mask], topup[mask])[0, 1])
    diff = f[mask] - topup[mask]
    metrics["field_vs_topup_offset_hz"] = float(np.median(diff))
    metrics["field_vs_topup_mad_demeaned_hz"] = float(
        np.median(np.abs(diff - np.median(diff)))
    )
    gre = run / "gre" / "gre_hz_on_ap.nii.gz"
    if gre.exists():
        g = load(gre)
        gmask = mask & (load(run / "gre" / "gre_mask_on_ap.nii.gz") > 0.5)
        metrics["field_vs_gre_mad_hz"] = float(np.median(np.abs(f[gmask] - g[gmask])))
        metrics["field_vs_gre_r"] = float(np.corrcoef(f[gmask], g[gmask])[0, 1])
        gdiff = f[gmask] - g[gmask]
        metrics["field_vs_gre_offset_hz"] = float(np.median(gdiff))
        metrics["field_vs_gre_mad_demeaned_hz"] = float(
            np.median(np.abs(gdiff - np.median(gdiff)))
        )
    (run / method / "metrics.json").write_text(json.dumps(metrics, indent=2) + "\n")
    print(json.dumps(metrics))


if __name__ == "__main__":
    main(*sys.argv[1:])
