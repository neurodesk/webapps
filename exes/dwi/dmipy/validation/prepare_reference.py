#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Verify pinned inputs and stage all eligible reference voxels for Rust comparison.

python prepare_reference.py REFERENCE_DIRECTORY PREPARED_DIRECTORY
Requires numpy and nibabel; the source fixture environment supplies both.
"""
import hashlib
import json
from pathlib import Path
import sys
import nibabel as nib
import numpy as np

root, destination = map(Path, sys.argv[1:])
manifest = json.loads(Path(__file__).with_name("reference.manifest.json").read_text())
for entry in manifest["files"] + manifest["inputs"]:
    path = root / entry["path"]
    assert path.stat().st_size == entry["bytes"], path
    assert hashlib.sha256(path.read_bytes()).hexdigest() == entry["sha256"], path
prefix = "sub-01_dir-AP_desc-slab"
image = nib.load(root / "input" / (prefix + "_dwi.nii.gz"))
data = image.get_fdata(dtype=np.float32)
mask_image = nib.load(root / (prefix + "_desc-brain_mask.nii.gz"))
assert np.allclose(mask_image.affine, image.affine, atol=1e-6)
mask = np.asarray(mask_image.dataobj) > 0
assert mask.shape == data.shape[:3] and int(mask.sum()) == 45965
reference = np.load(root / (prefix + "_model-noddi_desc-dmipy_parameters.npz"))
coordinates = np.argwhere(mask & (data[..., 0] > 0))
assert np.array_equal(coordinates, reference["ijk"])
assert len(coordinates) == 45951
wm_image = nib.load(root / "wm-mask.nii.gz")
assert np.allclose(wm_image.affine, image.affine, atol=1e-6)
wm = np.asarray(wm_image.dataobj) > 0
assert wm.shape == mask.shape and int(wm.sum()) == 13332 and not np.any(wm & ~mask)
wm_indices = np.flatnonzero(wm[tuple(coordinates.T)])
assert len(wm_indices) == 13324
signal = data[tuple(coordinates.T)].astype("<f8")
expected = np.column_stack([
    reference["SD1WatsonDistributed_1_SD1Watson_1_mu"],
    reference["SD1WatsonDistributed_1_SD1Watson_1_odi"],
    reference["SD1WatsonDistributed_1_partial_volume_0"],
    reference["partial_volume_0"], reference["mse"],
]).astype("<f8")
bvals = np.loadtxt(root / "input" / (prefix + "_dwi.bval"))
gradients = np.loadtxt(root / "input" / (prefix + "_dwi.bvec")).T
destination.mkdir(parents=True, exist_ok=True)
signal.tofile(destination / "signals.f64")
expected.tofile(destination / "expected.f64")
metadata = {"source": manifest["base"], "brainVoxels": int(mask.sum()), "eligibleVoxels": len(coordinates),
            "frames": len(bvals), "bvals": bvals.tolist(), "gradients": gradients.tolist(),
            "coordinates": coordinates.tolist(), "wmIndices": wm_indices.tolist(),
            "wmSelection": "Pinned FA >= 0.4 AND MindGrab brain mask, excluding dmipy-unfitted voxels; HF295e32650e9e28397909caff4b9741ee95a422c0",
            "files": {name: hashlib.sha256((destination / name).read_bytes()).hexdigest()
                      for name in ["signals.f64", "expected.f64"]}}
(destination / "prepared.json").write_text(json.dumps(metadata) + "\n")
print(f"{len(coordinates)} eligible voxels, {len(bvals)} frames; no WM subset assumed")
