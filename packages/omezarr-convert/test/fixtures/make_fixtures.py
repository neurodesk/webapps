"""Write the OME-TIFF fixtures of test/sources.test.js with tifffile (2026.10.15).

Run: python -I make_fixtures.py. value(t, c, z, y, x) is recomputed by the test.
"""
import numpy as np
import tifffile


def planes(shape, dtype):
    t, c, z, y, x = np.meshgrid(*[np.arange(n) for n in shape], indexing='ij')
    return ((t * 1000 + c * 100 + z * 10 + y * 3 + x) % 251).astype(dtype)


# T=2, C=3, Z=2 of 5 x 6 uint16, DimensionOrder XYCZT, channel names, nanometre pixels.
tifffile.imwrite(
    'tczyx-named.ome.tif', planes((2, 3, 2, 5, 6), np.uint16), ome=True, photometric='minisblack',
    metadata={
        'axes': 'TCZYX',
        'Name': 'named channels',
        'PhysicalSizeX': 65.0, 'PhysicalSizeXUnit': 'nm',
        'PhysicalSizeY': 65.0, 'PhysicalSizeYUnit': 'nm',
        'PhysicalSizeZ': 0.3, 'PhysicalSizeZUnit': 'µm',
        'Channel': {'Name': ['DAPI', 'GFP', 'mCherry'], 'Color': [65535, 16711935, -16776961]},
    },
)

# Float32, ZYX, no physical sizes.
tifffile.imwrite('zyx-float.ome.tif', (planes((1, 1, 3, 4, 7), np.float32) / 3)[0, 0], ome=True, metadata={'axes': 'ZYX'})

# A 16-bit greyscale PNG of 4 x 3 with pHYs 2,000,000 px/m in x and 1,000,000 in y (Pillow).
from PIL import Image  # noqa: E402

image = Image.fromarray(np.arange(12, dtype=np.uint16).reshape(3, 4) * 4000)
image.save('phys-16bit.png', dpi=(50800, 25400))
