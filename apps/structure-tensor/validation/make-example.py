"""Builds the SHG example from PSHG-TISS (Hristu et al. 2022, OSF udtqp, CC BY 4.0).

skin_12 is unstained human reticular dermis, forward-detected SHG at nine input polarisations
(0-160 degrees in 20 degree steps; 180 repeats 0). SHG from a fibre depends on the angle
between the fibre and the polarisation, so one polarisation favours some orientations; the sum
over the half turn is close to polarisation-independent. The sum is taken in int64 and must fit
uint16. It is written as uint16, uncompressed, uncalibrated: an ImageJ description with unit
"pixel" and a resolution of 1, so the app measures in pixels.

    python3 -I make-example.py <folder with skin_12_FSHG_p*.tif> <output.tif>
"""
import sys

import numpy as np
import tifffile

source, output = sys.argv[1], sys.argv[2]
angles = range(0, 180, 20)
stack = [tifffile.imread(f"{source}/skin_12_FSHG_p{angle}.tif") for angle in angles]
total = np.sum(np.asarray(stack, dtype=np.int64), axis=0)
assert total.min() >= 0 and total.max() <= np.iinfo(np.uint16).max, f"the sum spans {total.min()}..{total.max()}, outside uint16"
total = total.astype(np.uint16)
tifffile.imwrite(output, total, imagej=True, resolution=(1, 1), metadata={"unit": "pixel"})
print(output, total.shape, total.dtype, int(total.min()), int(total.max()))
