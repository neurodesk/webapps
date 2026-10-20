"""One resampler for every field, so the metrics compare fields, not resamplers.

corrected(x) = image(x + u(x)) * (1 + du/dx_pe), with u = S * f * trt * v in
voxels along the PE axis (linear interpolation, Jacobian modulation).
jacobian=False drops the modulation, for the reported metric that does not
penalize methods without an intensity model (3dQwarp, ANTs).
"""

import numpy as np
from scipy.ndimage import map_coordinates


def correct(image, field_hz, trt, v, axis, s, jacobian=True):
    u = s * field_hz * trt * v
    coords = np.indices(image.shape).astype(np.float64)
    coords[axis] += u
    warped = map_coordinates(image, coords, order=1, mode="constant", cval=0.0)
    if not jacobian:
        return warped
    jac = 1.0 + np.gradient(u, axis=axis)
    return warped * np.clip(jac, 0.0, None)
