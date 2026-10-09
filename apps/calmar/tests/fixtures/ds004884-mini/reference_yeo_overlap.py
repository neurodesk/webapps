#!/usr/bin/env python3
"""Independent reference for scripts/test_real_data_bridge.mjs.

Recomputes the ds004884 lesion -> MNI160 1 mm -> Yeo7 2 mm bridge and the
per-network voxel counts with nibabel, nilearn and numpy, without any of the
app's JavaScript, and writes expected_yeo_overlap.json next to this file.

    python3 tests/fixtures/ds004884-mini/reference_yeo_overlap.py

Verified with nibabel 5, nilearn 0.13, numpy 2.4, scipy 1.17.

Grid definitions (inputs to both implementations, not results):
  * MNI160: 160 x 160 x 192 at 1 mm in FSL MNI orientation (x flipped),
    translated so the lesion centroid sits at voxel (80, 80, 96).
  * Yeo7:   the committed atlas file's own affine and shape.
Both resampling steps use nearest-neighbour interpolation.
"""

import json
from pathlib import Path

import nibabel as nib
import numpy as np
from nilearn.image import resample_img
from scipy import ndimage

HERE = Path(__file__).resolve().parent
LESION = HERE / "lesion_mask.nii.gz"
ATLAS = HERE.parent / "yeo7-mini" / "atlas.nii.gz"
NETWORKS = {
    1: "Visual",
    2: "Somatomotor",
    3: "DorsalAttention",
    4: "VentralAttention",
    5: "Limbic",
    6: "Frontoparietal",
    7: "Default",
}

lesion_img = nib.load(LESION)
atlas_img = nib.load(ATLAS)
lesion = (np.asanyarray(lesion_img.dataobj) > 0).astype(np.uint8)
atlas = np.asanyarray(atlas_img.dataobj).astype(np.int16)

centroid_voxel = np.argwhere(lesion).mean(axis=0)
centroid_world = (lesion_img.affine @ np.append(centroid_voxel, 1.0))[:3]
mni_shape = (160, 160, 192)
mni_affine = np.array(
    [
        [-1.0, 0.0, 0.0, centroid_world[0] + 80],
        [0.0, 1.0, 0.0, centroid_world[1] - 80],
        [0.0, 0.0, 1.0, centroid_world[2] - 96],
        [0.0, 0.0, 0.0, 1.0],
    ]
)

source_img = nib.Nifti1Image(lesion, lesion_img.affine)
mni_img = resample_img(
    source_img,
    target_affine=mni_affine,
    target_shape=mni_shape,
    interpolation="nearest",
    force_resample=True,
    copy_header=True,
)
mni = (np.asanyarray(mni_img.dataobj) > 0).astype(np.uint8)
yeo_img = resample_img(
    nib.Nifti1Image(mni, mni_affine),
    target_affine=atlas_img.affine,
    target_shape=atlas_img.shape,
    interpolation="nearest",
    force_resample=True,
    copy_header=True,
)
yeo = np.asanyarray(yeo_img.dataobj) > 0


def nearest(volume, source_affine, target_shape, target_affine):
    """Second opinion: plain SciPy nearest-neighbour resampling."""
    transform = np.linalg.inv(source_affine) @ target_affine
    grid = np.indices(target_shape).reshape(3, -1)
    coordinates = transform[:3, :3] @ grid + transform[:3, 3:4]
    sampled = ndimage.map_coordinates(volume, coordinates, order=0, mode="constant", cval=0)
    return sampled.reshape(target_shape)


mni_scipy = nearest(lesion, lesion_img.affine, mni_shape, mni_affine)
yeo_scipy = nearest(mni_scipy, mni_affine, atlas_img.shape, atlas_img.affine) > 0
disagreement = {
    "mni": int(np.count_nonzero(mni_scipy != mni)),
    "yeo": int(np.count_nonzero(yeo_scipy != yeo)),
}

labels_under_lesion = atlas[yeo]
counts = np.bincount(labels_under_lesion, minlength=8)
expected = {
    "_comment": (
        "Independent reference, not a recording of the app's output. Written by "
        "`python3 tests/fixtures/ds004884-mini/reference_yeo_overlap.py` "
        "(nibabel + nilearn resample_img(interpolation='nearest') + numpy.bincount). "
        "Regenerate only by re-running that script."
    ),
    "fixture": "ds004884-mini/lesion_mask.nii.gz",
    "atlas": "yeo7-mini/atlas.nii.gz",
    "atlasAffine": atlas_img.affine.tolist(),
    "totals": {
        "sourceLesionVoxels": int(lesion.sum()),
        "mniLesionVoxels": int(mni.sum()),
        "yeoLesionVoxels": int(yeo.sum()),
        "voxelsOutsideAtlas": int(counts[0]),
    },
    "centroidSourceVoxel": [round(float(value), 4) for value in centroid_voxel],
    "centroidSourceWorld": [round(float(value), 4) for value in centroid_world],
    "centroidMni160Voxel": [round(float(value), 4) for value in np.argwhere(mni).mean(axis=0)],
    "networks": {name: int(counts[label]) for label, name in NETWORKS.items()},
    "nilearnVersusScipyVoxelDisagreement": disagreement,
}
(HERE / "expected_yeo_overlap.json").write_text(json.dumps(expected, indent=2) + "\n")
print(json.dumps(expected, indent=2))
