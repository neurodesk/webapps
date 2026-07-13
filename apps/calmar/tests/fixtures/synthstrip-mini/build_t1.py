#!/usr/bin/env python3
"""Rebuild the SynthStrip parity-test T1 fixture from nilearn's MNI152 2mm.

See SOURCE.md for the choice of template and the trade-off vs a raw IXI
subject. Running this is a one-shot dev step; the produced T1.nii.gz is
committed to the repo so the parity test does not need network at run time.
"""
import os
import hashlib
import numpy as np
import nibabel as nib
from nilearn.datasets import load_mni152_template

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "T1.nii.gz")


def main():
    img = load_mni152_template(resolution=2)
    expected = (99, 117, 95)
    if img.shape != expected:
        raise SystemExit(f"unexpected shape {img.shape}; expected {expected}")
    data = np.asarray(img.dataobj).astype(np.float32)
    out = nib.Nifti1Image(data, img.affine)
    out.set_data_dtype(np.float32)
    nib.save(out, OUT)

    sha = hashlib.sha256(open(OUT, "rb").read()).hexdigest()
    print(f"Wrote {OUT}: shape={data.shape}, dtype=float32, "
          f"size={os.path.getsize(OUT)} bytes, sha256={sha}")


if __name__ == "__main__":
    main()
