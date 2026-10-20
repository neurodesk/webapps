"""Extract the b0 volumes of each PE direction and write the topup inputs.

Usage: prep.py <out-dir> <ap.nii.gz> <ap.json> <ap.bval|-> <pa.nii.gz> <pa.json> <pa.bval|->

Both series are cropped to an even number of slices (topup's b02b0.cnf
subsamples by 2), and every method gets the same cropped data.
"""

import json
import sys
from pathlib import Path

import nibabel as nb
import numpy as np

B0_MAX = 50
AXES = {"i": (1, 0, 0), "j": (0, 1, 0), "k": (0, 0, 1)}


def pe_vector(direction):
    vec = np.array(AXES[direction[0]])
    return -vec if direction.endswith("-") else vec


def b0_volumes(path, bval):
    img = nb.load(path)
    data = np.asarray(img.dataobj, dtype=np.float32)
    if data.ndim == 3:
        data = data[..., None]
    if bval == "-":
        keep = np.arange(data.shape[3])
    else:
        keep = np.flatnonzero(np.loadtxt(bval, ndmin=1) <= B0_MAX)
    nz = data.shape[2] - data.shape[2] % 2
    return data[:, :, :nz, keep], img


def main(out, ap, ap_json, ap_bval, pa, pa_json, pa_bval):
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    meta = {}
    rows = []
    stacks = []
    for name, path, sidecar, bval in (
        ("ap", ap, ap_json, ap_bval),
        ("pa", pa, pa_json, pa_bval),
    ):
        side = json.loads(Path(sidecar).read_text())
        data, img = b0_volumes(path, bval)
        hdr = img.header.copy()
        hdr.set_data_dtype(np.float32)
        nb.Nifti1Image(data, img.affine, hdr).to_filename(out / f"{name}_b0s.nii.gz")
        trt = float(side["TotalReadoutTime"])
        vec = pe_vector(side["PhaseEncodingDirection"])
        rows += [f"{vec[0]} {vec[1]} {vec[2]} {trt}"] * data.shape[3]
        stacks.append(data)
        meta[name] = {
            "pe": side["PhaseEncodingDirection"],
            "trt": trt,
            "volumes": int(data.shape[3]),
        }
    np.savetxt(out / "acqparams.txt", rows, fmt="%s")
    first = nb.load(out / "ap_b0s.nii.gz")
    merged = np.concatenate(stacks, axis=3)
    nb.Nifti1Image(merged, first.affine, first.header).to_filename(
        out / "topup_in.nii.gz"
    )
    # One b0 per direction, for the topup sensitivity check.
    single = np.stack([stacks[0][..., 0], stacks[1][..., 0]], axis=3)
    nb.Nifti1Image(single, first.affine, first.header).to_filename(
        out / "topup_in_single.nii.gz"
    )
    np.savetxt(out / "acqparams_single.txt", [rows[0], rows[-1]], fmt="%s")
    (out / "prep.json").write_text(json.dumps(meta, indent=2) + "\n")


if __name__ == "__main__":
    main(*sys.argv[1:])
