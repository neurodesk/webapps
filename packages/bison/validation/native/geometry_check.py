"""Decide which XFM makes itk_resample put template images on the subject.

mincresample -invert_transformation with T1toTemplate_pp_both.xfm is the
unambiguous template -> subject mapping and gives Mask_nl. For each candidate
XFM (forward = pp_both, inverse = xfminvert pp_both) the driver ran
itk_resample on Mask.mnc and SP_1.mnc (ventricles). The right candidate gives
a mask that matches Mask_nl and a ventricle prior over dark T1 voxels.
"""

import argparse
import json
from pathlib import Path

import numpy as np
import SimpleITK as sitk


def read(path):
    return sitk.GetArrayFromImage(sitk.ReadImage(path)).astype(np.float64)


def dice(a, b):
    return float(2 * np.sum(a & b) / (np.sum(a) + np.sum(b)))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--t1", required=True)
    ap.add_argument("--mask-nl", required=True)
    ap.add_argument("--mask-lin", required=True)
    ap.add_argument("--geometry-dir", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()

    t1 = read(a.t1)
    mask_nl = read(a.mask_nl) > 0
    mask_lin = read(a.mask_lin) > 0
    assert t1.shape == mask_nl.shape == mask_lin.shape
    # Rough intensity brain mask: T1_VP above half the median of the linear mask.
    rough = t1 > 0.5 * np.median(t1[mask_lin])
    result = {
        "voxels_mask_nl": int(mask_nl.sum()),
        "dice_mask_nl_vs_mask_lin": dice(mask_nl, mask_lin),
        "dice_mask_nl_vs_rough_intensity": dice(mask_nl, rough & mask_lin),
        "mean_t1_in_mask_nl": float(t1[mask_nl].mean()),
        "candidates": {},
    }
    for cand in ["forward", "inverse"]:
        m = read(f"{a.geometry_dir}/mask_{cand}.mnc") > 0.5
        sp1 = read(f"{a.geometry_dir}/sp1_{cand}.mnc")
        vent = (sp1 > 0.5) & mask_nl
        result["candidates"][cand] = {
            "dice_itk_mask_vs_mask_nl": dice(m, mask_nl),
            "voxels_sp1_gt_0.5": int(vent.sum()),
            "mean_t1_in_sp1_gt_0.5": float(t1[vent].mean()) if vent.any() else None,
            "ratio_to_mask_mean": float(t1[vent].mean() / result["mean_t1_in_mask_nl"])
            if vent.any()
            else None,
        }
    best = max(
        result["candidates"],
        key=lambda c: result["candidates"][c]["dice_itk_mask_vs_mask_nl"],
    )
    result["chosen"] = best
    Path(a.out).write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
