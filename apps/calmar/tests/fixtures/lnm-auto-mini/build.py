#!/usr/bin/env python3
"""Build a 160x160x192 1mm MNI fixture for the Phase 10 auto-branch smoke.

The full-pipeline auto branch needs a structural T1 at exactly the
SynthMorph-required pose (160x160x192, 1 mm isotropic, roughly MNI-aligned).
Real clinical T1s require an upstream affine registration step the webapp
does not ship. To exercise the full chain end-to-end without that
prerequisite, we use the MNI152NLin2009cAsym 1mm template — already
MNI-aligned by construction — and plant a synthetic hypointensity sphere
to simulate a stroke lesion. SynthStroke may or may not detect it; the
smoke test asserts the chain *completes*, not the model's accuracy.

The output affine matches `lnm-mni160` (the SynthMorph reference target)
so the registration step converges near-identity.
"""

import nibabel as nib
import numpy as np
from nilearn.datasets import load_mni152_template
from nilearn.image import resample_img
from pathlib import Path

OUT = Path(__file__).parent / "T1.nii.gz"
DIMS = (160, 160, 192)
SPACING = (1.0, 1.0, 1.0)


def _target_affine():
    # FSL MNI152 1mm convention, centered on the brain so the 160x160x192
    # crop captures the entire head (mirrors what build_lnm_mni160.py does
    # for the SynthMorph reference).
    a = np.eye(4)
    a[0, 0] = -SPACING[0]
    a[1, 1] = SPACING[1]
    a[2, 2] = SPACING[2]
    # Origin: centred on (0, -18, -18) world-mm.
    a[0, 3] = (DIMS[0] / 2 - 1) * SPACING[0]
    a[1, 3] = -(DIMS[1] / 2) * SPACING[1] - 18
    a[2, 3] = -(DIMS[2] / 2) * SPACING[2] - 18
    return a


def _plant_lesion(arr, center_vox, radius_vox=8):
    """In-place: drop intensity inside a sphere to ~30% of local mean."""
    cx, cy, cz = center_vox
    X, Y, Z = arr.shape
    local = arr[
        max(0, cx - radius_vox * 2): cx + radius_vox * 2,
        max(0, cy - radius_vox * 2): cy + radius_vox * 2,
        max(0, cz - radius_vox * 2): cz + radius_vox * 2,
    ]
    local_mean = float(local[local > 0.05].mean()) if (local > 0.05).any() else 1.0
    target = local_mean * 0.3
    for i in range(max(0, cx - radius_vox), min(X, cx + radius_vox + 1)):
        for j in range(max(0, cy - radius_vox), min(Y, cy + radius_vox + 1)):
            for k in range(max(0, cz - radius_vox), min(Z, cz + radius_vox + 1)):
                d2 = (i - cx) ** 2 + (j - cy) ** 2 + (k - cz) ** 2
                if d2 <= radius_vox * radius_vox:
                    arr[i, j, k] = target


def main():
    template = load_mni152_template(resolution=1)
    print(f"Source: shape={template.shape}, zooms={template.header.get_zooms()}")

    target_affine = _target_affine()
    resampled = resample_img(
        template,
        target_affine=target_affine,
        target_shape=DIMS,
        interpolation="continuous",
        force_resample=True,
        copy_header=True,
    )
    arr = np.asarray(resampled.dataobj, dtype=np.float32)
    print(f"Resampled: shape={arr.shape}, range=[{arr.min():.3f}, {arr.max():.3f}]")

    # Plant a 8-voxel-radius lesion in left posterior temporal cortex (rough
    # MNI -50, -55, +5 mm). Convert to voxel coords via inv(affine).
    inv = np.linalg.inv(target_affine)
    world = np.array([-50.0, -55.0, 5.0, 1.0])
    vox = inv @ world
    cx, cy, cz = int(round(vox[0])), int(round(vox[1])), int(round(vox[2]))
    print(f"Planting lesion at voxel ({cx}, {cy}, {cz}) — world (-50, -55, 5)")
    _plant_lesion(arr, (cx, cy, cz), radius_vox=8)

    # Save as int16 (range ~[0, 4000]) to halve gzipped file size while
    # preserving enough dynamic range for SynthStrip / SynthStroke. The
    # worker min-max normalises before SynthMorph, so absolute scale is
    # not load-bearing.
    arr16 = np.clip(arr, 0, None) * 4000.0
    arr16 = np.round(arr16).astype(np.int16)
    out_img = nib.Nifti1Image(arr16, target_affine)
    out_img.set_data_dtype(np.int16)
    nib.save(out_img, OUT)
    print(f"Wrote {OUT} ({OUT.stat().st_size / 1e6:.2f} MB)")


if __name__ == "__main__":
    main()
