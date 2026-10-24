"""Rebuild BISON's PT feature matrix from the checkpoints and export the reference.

The feature code repeats BISON_L8.py / BISON_L9.py (PT mode, T1 and FLAIR only)
operation for operation: SimpleITK arrays in MINC (z, y, x) order, T1 and FLAIR
clipped in place to [1, 255] before any use, histogram index np.round(x) (half to
even) cast to int32, X built as float64. The script asserts that predict on this X
equals the upstream _Label.mnc, and that sklearn's own float32 cast changes nothing.

Writes to --out:
  X.npy                float32 (N, F): the matrix sklearn classifies
  mask_index.npy       int64 (N,): linear voxel index into the native NIfTI T1
                       (i fastest, the NIfTI file order); X row order follows it
  mask_ijk.npy         int32 (N, 3): the same voxels as NIfTI (i, j, k)
  classes.npy          clf.classes_
  predict.npy          int32 (N,)
  predict_proba.npy    float32 (N, n_classes), columns in classes.npy order
  nifti/<t1>_bison-labels.nii.gz       uint8 on the native T1 grid
  nifti/<t1>_bison-prob-<class>.nii.gz float32, one per tissue class (classes 1..n)
  nifti/<t1>_bison-mask.nii.gz         uint8 (Mask_nl)
  nifti/checkpoints/*.nii.gz           T1_VP, FLAIR_CR, warped priors and av images
  summary.json
"""

import argparse
import json
import os
from pathlib import Path

import joblib
import nibabel as nib
import numpy as np
import SimpleITK as sitk

IMAGE_RANGE = 256
SLUGS = {
    1: "ventricles",
    2: "csf",
    3: "cerebellar-gm",
    4: "cerebellar-wm",
    5: "brainstem",
    6: "deep-gm",
    7: "cortical-gm",
    8: "wm",
    9: "wmh",
}


def arr(path):
    return sitk.GetArrayFromImage(sitk.ReadImage(path))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--lib", required=True)
    ap.add_argument("--labels", type=int, required=True)
    ap.add_argument("--t1", required=True)
    ap.add_argument("--flair")
    ap.add_argument("--mask", required=True)
    ap.add_argument("--warped", required=True)
    ap.add_argument("--label-mnc", required=True)
    ap.add_argument("--raw-t1", required=True)
    ap.add_argument("--raw-t1-mnc", required=True)
    ap.add_argument("--preproc", required=True)
    ap.add_argument("--id", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    n_labels = a.labels
    os.makedirs(os.path.join(a.out, "nifti", "checkpoints"), exist_ok=True)

    # ---- features, as upstream PT mode ------------------------------------------------
    Mask = arr(a.mask)
    ind_Mask = Mask > 0
    N = int(np.sum(Mask))
    assert N == int(ind_Mask.sum()), "mask is not binary 0/1"
    spatial_priors = np.empty(shape=(N, n_labels), dtype=float, order="C")
    for nl in range(n_labels):
        spatial_priors[0:N, nl] = arr(f"{a.warped}/sp_{nl + 1}.mnc")[ind_Mask]
    T1 = arr(a.t1)
    av_T1 = arr(f"{a.warped}/av_t1.mnc")
    T1[T1 < 1] = 1
    T1[T1 > (IMAGE_RANGE - 1)] = IMAGE_RANGE - 1
    T1_PDF_Label = joblib.load(f"{a.lib}/T1_Label.pkl")
    T1_Label_probability = np.empty(shape=(N, n_labels), dtype=float, order="C")
    for nl in range(n_labels):
        T1_Label_probability[:, nl] = T1_PDF_Label[
            np.round(T1[ind_Mask]).astype(np.int32), nl
        ]
    X_t1 = np.zeros(shape=(N, 2))
    X_t1[0:N, 0] = T1[ind_Mask]
    X_t1[0:N, 1] = av_T1[ind_Mask]
    X_t1 = np.concatenate((X_t1, T1_Label_probability), axis=1)
    columns = [f"SP_{k + 1}" for k in range(n_labels)] + ["T1", "Av_T1"]
    columns += [f"T1_hist_{k + 1}" for k in range(n_labels)]
    X = np.concatenate((np.zeros(shape=(N, 0)), spatial_priors, X_t1), axis=1)
    if a.flair:
        FLAIR = arr(a.flair)
        av_FLAIR = arr(f"{a.warped}/av_flair.mnc")
        FLAIR[FLAIR < 1] = 1
        FLAIR[FLAIR > (IMAGE_RANGE - 1)] = IMAGE_RANGE - 1
        FLAIR_PDF_Label = joblib.load(f"{a.lib}/FLAIR_Label.pkl")
        FLAIR_Label_probability = np.empty(shape=(N, n_labels), dtype=float, order="C")
        for nl in range(n_labels):
            FLAIR_Label_probability[:, nl] = FLAIR_PDF_Label[
                np.round(FLAIR[ind_Mask]).astype(np.int32), nl
            ]
        X_flair = np.zeros(shape=(N, 4))
        X_flair[0:N, 0] = FLAIR[ind_Mask]
        X_flair[0:N, 1] = av_FLAIR[ind_Mask]
        X_flair[0:N, 2] = FLAIR[ind_Mask] / T1[ind_Mask]
        X_flair = np.concatenate((X_flair, FLAIR_Label_probability), axis=1)
        X = np.concatenate((X, X_flair), axis=1)
        columns += ["FLAIR", "Av_FLAIR", "FLAIR/T1", "zero"]
        columns += [f"FLAIR_hist_{k + 1}" for k in range(n_labels)]
    assert X.shape[1] == len(columns)

    name = (
        "RF0_T1exists_T2_PD_FLAIRexists.pkl"
        if a.flair
        else "RF0_T1exists_T2_PD_FLAIR.pkl"
    )
    clf = joblib.load(f"{a.lib}/{name}")
    clf.n_jobs = 1
    pred = clf.predict(X)
    proba = clf.predict_proba(X)
    X32 = X.astype(np.float32)
    pred32 = clf.predict(X32)
    proba32 = clf.predict_proba(X32)
    assert np.array_equal(pred, pred32), "float32 cast changes predict"
    assert np.array_equal(proba, proba32), "float32 cast changes predict_proba"

    upstream = arr(a.label_mnc)
    assert upstream.shape == Mask.shape
    assert np.array_equal(upstream[ind_Mask], pred), (
        "predict differs from upstream _Label.mnc"
    )
    assert not np.any(upstream[~ind_Mask]), "upstream labels outside the mask"
    # Upstream writes column nl as Prob_Label_<nl+1>; classes_ starts at 0.
    prob_check = {}
    for nl in range(n_labels):
        up = arr(
            os.path.join(
                os.path.dirname(a.label_mnc), f"RF0_{a.id}_Prob_Label_{nl + 1}.mnc"
            )
        )[ind_Mask]
        prob_check[f"Prob_Label_{nl + 1}"] = {
            "max_abs_vs_column": float(np.abs(up - proba[:, nl]).max()),
            "column_class": int(clf.classes_[nl]),
        }

    # ---- native NIfTI grid --------------------------------------------------------------
    raw = nib.load(a.raw_t1)
    raw_data = np.asanyarray(raw.dataobj).astype(np.float64)
    # nii2mnc keeps the voxel order: the SimpleITK (z, y, x) array transposed is the
    # NIfTI (i, j, k) array (checked here on the raw T1; differences are MINC slice scaling).
    t1_mnc = arr(a.raw_t1_mnc).transpose(2, 1, 0).astype(np.float64)
    assert t1_mnc.shape == raw_data.shape
    map_err = float(np.abs(t1_mnc - raw_data).max())
    assert map_err <= 1e-4 * float(np.abs(raw_data).max()) + 1e-3, map_err

    def to_nii(volume, dtype, path):
        img = nib.Nifti1Image(
            np.asarray(volume.transpose(2, 1, 0), dtype=dtype), raw.affine
        )
        img.set_qform(raw.affine, code=int(raw.header["qform_code"]))
        img.set_sform(raw.affine, code=int(raw.header["sform_code"]))
        img.header.set_xyzt_units(*raw.header.get_xyzt_units())
        nib.save(img, path)

    stem = os.path.basename(a.raw_t1).removesuffix(".nii.gz")
    labels = np.zeros(Mask.shape, dtype=np.uint8)
    labels[ind_Mask] = pred.astype(np.uint8)
    to_nii(labels, np.uint8, f"{a.out}/nifti/{stem}_bison-labels.nii.gz")
    to_nii(
        ind_Mask.astype(np.uint8), np.uint8, f"{a.out}/nifti/{stem}_bison-mask.nii.gz"
    )
    classes = [int(c) for c in clf.classes_]
    for k in range(1, n_labels + 1):
        p = np.zeros(Mask.shape, dtype=np.float32)
        p[ind_Mask] = proba[:, classes.index(k)]
        to_nii(p, np.float32, f"{a.out}/nifti/{stem}_bison-prob-{SLUGS[k]}.nii.gz")
    ck = f"{a.out}/nifti/checkpoints"
    to_nii(arr(a.t1), np.float32, f"{ck}/T1_VP.nii.gz")
    if a.flair:
        to_nii(arr(a.flair), np.float32, f"{ck}/FLAIR_CR.nii.gz")
        to_nii(arr(f"{a.warped}/av_flair.mnc"), np.float32, f"{ck}/av_flair.nii.gz")
    to_nii(arr(f"{a.warped}/av_t1.mnc"), np.float32, f"{ck}/av_t1.nii.gz")
    for k in range(1, n_labels + 1):
        to_nii(arr(f"{a.warped}/sp_{k}.mnc"), np.float32, f"{ck}/sp_{k}.nii.gz")

    # ---- arrays for classifier parity ---------------------------------------------------
    z, y, x = np.nonzero(ind_Mask)
    nx, ny, _ = raw_data.shape
    np.save(f"{a.out}/X.npy", X32)
    np.save(f"{a.out}/mask_index.npy", (x + nx * (y + ny * z)).astype(np.int64))
    np.save(f"{a.out}/mask_ijk.npy", np.stack([x, y, z], axis=1).astype(np.int32))
    np.save(f"{a.out}/classes.npy", clf.classes_)
    np.save(f"{a.out}/predict.npy", pred.astype(np.int32))
    np.save(f"{a.out}/predict_proba.npy", proba.astype(np.float32))

    voxel_ml = float(np.prod(raw.header.get_zooms()[:3])) / 1000.0
    counts = {int(c): int(np.sum(pred == c)) for c in clf.classes_}
    summary = {
        "id": a.id,
        "mode": "t1-flair" if a.flair else "t1",
        "classifier": name,
        "n_features": int(X.shape[1]),
        "columns": columns,
        "n_voxels": N,
        "classes": classes,
        "voxel_ml": voxel_ml,
        "counts": counts,
        "volumes_ml": {
            SLUGS.get(c, str(c)): round(n * voxel_ml, 3) for c, n in counts.items()
        },
        "predict_equals_upstream_label": True,
        "float32_cast_identical": True,
        "native_grid_map_max_abs": map_err,
        "upstream_prob_files": prob_check,
    }
    Path(f"{a.out}/summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(
        json.dumps(
            {k: summary[k] for k in ["mode", "n_features", "n_voxels", "volumes_ml"]},
            indent=2,
        )
    )
    Path(f"{a.out}/done").write_text("ok\n")


if __name__ == "__main__":
    main()
