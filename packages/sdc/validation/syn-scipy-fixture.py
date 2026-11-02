"""Writes test/fixtures/syn-scipy.json: SciPy/NumPy/niworkflows outputs on small random volumes
for the JavaScript ports in src/syn/numerics.js (median filter, clip, dilation, Laplacian
normalisation, cubic spline sampling, gradient). Run with the sdcflows 2.17.1 environment of
the reference (exes/dwi/sdc/validation, env/uv-pip-freeze.txt):

    python -I packages/sdc/validation/syn-scipy-fixture.py packages/sdc/test/fixtures/syn-scipy.json
"""

import json
import sys

import numpy as np
from scipy import ndimage
from skimage.morphology import ball

rng = np.random.default_rng(464)
shape = (9, 8, 7)
# NIfTI order: x fastest. A C-order array of shape (x, y, z) flattened in Fortran order.
flat = lambda a: [float(v) for v in np.asarray(a).ravel(order="F")]

image = np.round(rng.gamma(2.0, 50.0, size=shape)).astype(np.float32)
image[:2] = 0
median = ndimage.median_filter(image, footprint=ball(3))

positive = median[median > 0]
low, high = np.percentile(positive, 35), np.percentile(positive, 99.98)
clipped = np.clip(image, a_min=low, a_max=high)
clipped -= clipped.min()
clipped /= clipped.max()
clip_int16 = np.round(255 * clipped).astype("int16")

mask = rng.random(shape) > 0.93
dilated = ndimage.binary_dilation(mask, ball(3)).astype("uint8")

lap = rng.normal(0.0, 3.0, size=shape)
data = lap.copy()
data -= np.median(data)
l_max = np.percentile(data[data > 0], 99.8)
l_min = np.percentile(data[data < 0], 0.2)
data[data < 0] *= -1.0 / l_min
data[data > 0] *= 1.0 / l_max
norm = np.clip(data, -1.0, 1.0).astype("float32")

coords = np.stack(
    [
        rng.uniform(-0.5, shape[0] - 0.5, 40),
        rng.uniform(-0.5, shape[1] - 0.5, 40),
        rng.uniform(-0.5, shape[2] - 0.5, 40),
    ]
).astype("float32")
coords[:, 0] = [0, 0, 0]
coords[:, 1] = [shape[0] - 1, shape[1] - 1, shape[2] - 1]
sampled = ndimage.map_coordinates(image.astype("int16"), coords, output="float32", order=3, mode="constant", cval=0, prefilter=True)

vsm = rng.normal(0, 1, size=shape).astype("float32")
gradient = np.gradient(vsm, axis=1)

json.dump(
    {
        "shape": list(shape),
        "image": flat(image),
        "median": flat(median),
        "clip": {"pMin": 35, "pMax": 99.98, "int16": flat(clip_int16)},
        "mask": flat(mask.astype("uint8")),
        "dilated": flat(dilated),
        "laplacian": flat(lap),
        "normalized": flat(norm),
        "coordinates": [[float(v) for v in row] for row in coords],
        "sampled": [float(v) for v in sampled],
        "vsm": flat(vsm),
        "gradientY": flat(gradient),
    },
    open(sys.argv[1], "w"),
)
