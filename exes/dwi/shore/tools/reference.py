"""Convert one SHORELine iteration's SignalPrediction inputs and outputs to the raw layout
that tests/reference.rs reads (SHORE_REFERENCE).

    python -I tools/reference.py OUT_DIR --mask MASK --b0-mean B0_MEAN --bvals BVALS \\
        --bvecs BVECS --dwis DWI... --predicted PREDICTED...

The inputs are what QSIPrep 26.1.1 passed to the iteration's `predict_dwis` MapNode
(`workflows/dwi/hmc.py:608-618`): `aligned_mask`, `aligned_b0_mean`, the model DWI volumes
`aligned_dwis` (registered by the previous iteration, b0 volumes removed), their `bvals`, the
rotated `aligned_bvecs` (one FSL-style file, or one file per volume), and each map index's
`predicted_image`, in the same order as the DWIs. They are not `qsiprep/input/split_dwis`:
every iteration predicts from its own registered images.

OUT_DIR gets manifest.json and one little-endian float32 file per image, voxels in C order."""

import argparse
import json
import os

import nibabel as nb
import numpy as np

parser = argparse.ArgumentParser()
parser.add_argument("out")
parser.add_argument("--mask", required=True)
parser.add_argument("--b0-mean", required=True)
parser.add_argument("--bvals", required=True, nargs="+")
parser.add_argument("--bvecs", required=True, nargs="+")
parser.add_argument("--dwis", required=True, nargs="+")
parser.add_argument("--predicted", required=True, nargs="+")
args = parser.parse_args()
os.makedirs(args.out, exist_ok=True)


def concatenate_bvals(files):
    # qsiprep/interfaces/gradients.py concatenate_bvals
    return np.concatenate([np.loadtxt(f, ndmin=1) for f in files]).squeeze()


def concatenate_bvecs(files):
    # qsiprep/interfaces/gradients.py concatenate_bvecs
    if len(files) == 1:
        stacked = np.loadtxt(files[0])
    else:
        stacked = np.row_stack([np.loadtxt(f).astype(float) for f in files])
    if not stacked.shape[1] == 3:
        stacked = stacked.T
    return stacked


shape = None


def save(path, name):
    global shape
    image = nb.load(path)
    if shape is None:
        shape = image.shape[:3]
    if image.shape[:3] != shape:
        raise SystemExit(f"{path} has shape {image.shape}, not {shape}")
    # quick_load_images in shoreline.py loads every image as float32.
    data = image.get_fdata(dtype=np.float32)
    data.astype("<f4").ravel(order="C").tofile(os.path.join(args.out, name))
    return name


bvals = concatenate_bvals(args.bvals)
bvecs = concatenate_bvecs(args.bvecs)
if not len(bvals) == len(bvecs) == len(args.dwis) == len(args.predicted):
    raise SystemExit("--bvals, --bvecs, --dwis and --predicted must describe the same volumes")
manifest = {
    "mask": save(args.mask, "mask.f32"),
    "b0_mean": save(args.b0_mean, "b0_mean.f32"),
    "dwis": [save(p, f"dwi_{i:03d}.f32") for i, p in enumerate(args.dwis)],
    "predicted": [save(p, f"predicted_{i:03d}.f32") for i, p in enumerate(args.predicted)],
    "bvals": bvals.tolist(),
    "bvecs": bvecs.tolist(),
    "shape": list(shape),
}
with open(os.path.join(args.out, "manifest.json"), "w") as f:
    json.dump(manifest, f)
