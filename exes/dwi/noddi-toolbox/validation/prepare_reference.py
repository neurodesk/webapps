#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""Stage the WM gate voxels of the NODDI toolbox reference for tests/reference.rs.

Usage: python3 prepare_reference.py REFERENCE_DIRECTORY PREPARED_DIRECTORY
REFERENCE_DIRECTORY is fetch_reference.py's DEST. Needs numpy and nibabel.

The gate set is the pinned WM mask (MindGrab brain mask AND FA >= 0.4) without the
toolbox's error_code 2 voxels: 13327 voxels. PREPARED_DIRECTORY receives signals.f64
(each gate voxel's DWI signal, float64 little-endian, voxel-major), expected.f64 (the
toolbox's ICVF, ISOVF, ODI and fmin, its Rician log-likelihood, of each gate voxel) and
prepared.json (b-values,
b-vectors, voxel coordinates). The DWI is int16 with no scaling, as the toolbox read it.
"""
import hashlib
import json
from pathlib import Path
import sys

import nibabel as nib
import numpy as np

root, destination = map(Path, sys.argv[1:])
manifest = json.loads(Path(__file__).with_name("reference.manifest.json").read_text())
for entry in manifest["inputs"] + manifest["files"] + [manifest["wmSelection"]]:
    path = root / entry["path"]
    assert path.stat().st_size == entry["bytes"], path
    assert hashlib.sha256(path.read_bytes()).hexdigest() == entry["sha256"], path
prefix = "sub-01_dir-AP_desc-slab"
image = nib.load(root / "input" / f"{prefix}_dwi.nii.gz")
data = np.asanyarray(image.dataobj).astype(np.float64)


def load(name):
    other = nib.load(root / name)
    assert np.allclose(other.affine, image.affine, atol=1e-6), name
    return np.asanyarray(other.dataobj)


brain = load(f"{prefix}_desc-brain_mask.nii.gz") > 0
wm = load("wm-mask.nii.gz") > 0
errors = load(f"{prefix}_model-noddi_param-errorcode_dwimap.nii.gz")
assert int(brain.sum()) == 45965 and int(wm.sum()) == 13332 and not np.any(wm & ~brain)
assert int((errors[brain] == 2).sum()) == 14
gate = wm & (errors == 0)
assert int(gate.sum()) == manifest["wmSelection"]["expectedGateVoxels"]
coordinates = np.argwhere(gate)
index = tuple(coordinates.T)
expected = np.column_stack([
    load(f"{prefix}_model-noddi_param-{param}_dwimap.nii.gz")[index].astype(np.float64)
    for param in ["icvf", "isovf", "odi", "fmin"]
])
bvals = np.loadtxt(root / "input" / f"{prefix}_dwi.bval")
bvecs = np.loadtxt(root / "input" / f"{prefix}_dwi.bvec").T
destination.mkdir(parents=True, exist_ok=True)
data[index].astype("<f8").tofile(destination / "signals.f64")
expected.astype("<f8").tofile(destination / "expected.f64")
metadata = {
    "source": manifest["base"],
    "gateVoxels": len(coordinates),
    "bvals": bvals.tolist(),
    "bvecs": bvecs.tolist(),
    "coordinates": coordinates.tolist(),
}
(destination / "prepared.json").write_text(json.dumps(metadata) + "\n")
print(f"{len(coordinates)} gate voxels, {len(bvals)} volumes")
