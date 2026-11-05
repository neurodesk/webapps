"""Builds the SHG example from PSHG-TISS (Hristu et al. 2022, OSF udtqp, CC BY 4.0).

skin_12 is unstained human reticular dermis, forward-detected SHG at nine input polarisations
(0-160 degrees in 20 degree steps; 180 repeats 0). SHG from a fibre depends on the angle
between the fibre and the polarisation, so one polarisation favours some orientations; the sum
over the half turn is close to polarisation-independent. It is written as uint16, uncompressed,
with the source's ImageJ calibration.

    python3 -I make-example.py <folder with skin_12_FSHG_p*.tif> <output.tif>
"""
import sys

import numpy as np
import tifffile

source, output = sys.argv[1], sys.argv[2]
angles = range(0, 180, 20)
stack = [tifffile.imread(f"{source}/skin_12_FSHG_p{angle}.tif").astype(np.uint16) for angle in angles]
total = np.sum(stack, axis=0, dtype=np.uint16)
tifffile.imwrite(output, total, imagej=True, resolution=(1, 1), metadata={"unit": "pixel"})
print(output, total.shape, total.dtype, int(total.min()), int(total.max()))
