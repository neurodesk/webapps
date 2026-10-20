"""Write DRBUDDI's b0-only inputs the way QSIPrep's GatherDRBUDDIInputs does.

Usage: drbuddi_inputs.py <ap_mean> <pa_mean> <ap-pe> <out-dir>

Both images are reoriented to LPS and written as float32 .nii with a one-row
dummy .bmtxt. The PE direction follows the reorientation: an axis that is
flipped or moved changes the label.
"""

import json
import sys
from pathlib import Path

import nibabel as nb
import numpy as np
from nibabel.orientations import axcodes2ornt, io_orientation, ornt_transform

AXES = "ijk"


def to_lps(path):
    img = nb.load(path)
    xform = ornt_transform(io_orientation(img.affine), axcodes2ornt("LPS"))
    out = img.as_reoriented(xform)
    out = nb.Nifti1Image(np.asarray(out.dataobj, dtype=np.float32), out.affine)
    return out, xform


def moved_pe(pe, xform):
    old = AXES.index(pe[0])
    new_axis, flip = xform[old]
    sign = -1 if pe.endswith("-") else 1
    sign *= int(flip)
    return AXES[int(new_axis)] + ("-" if sign < 0 else "")


ap, pa, pe, out = sys.argv[1:]
out = Path(out)
for name, path in (("blip_up_b0", ap), ("blip_down_b0", pa)):
    img, xform = to_lps(path)
    img.to_filename(out / f"{name}.nii")
    (out / f"{name}.bmtxt").write_text("0 0 0 0 0 0\n")
up_pe = moved_pe(pe, xform)
(out / "blip_up.json").write_text(json.dumps({"PhaseEncodingDirection": up_pe}) + "\n")
(out / "lps.json").write_text(
    json.dumps({"xform": xform.tolist(), "up_pe": up_pe}) + "\n"
)
