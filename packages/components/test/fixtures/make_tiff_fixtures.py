"""Writes the small TIFF fixtures of test/tiff.test.js with tifffile (2026.3.3).

    python -I make_tiff_fixtures.py <fixtures directory>
"""
import sys

import numpy as np
import tifffile


def main(out):
    ramp = np.arange(3 * 4 * 5, dtype=np.uint16).reshape(3, 4, 5) * 997
    tifffile.imwrite(f"{out}/stack-deflate-uint16.ome.tif", ramp, ome=True, compression="zlib", predictor=True,
                     metadata={"axes": "TYX", "TimeIncrement": 0.25, "TimeIncrementUnit": "s",
                               "PhysicalSizeX": 0.5, "PhysicalSizeXUnit": "µm", "PhysicalSizeY": 750, "PhysicalSizeYUnit": "nm"})
    signed = (np.arange(3 * 4 * 5, dtype=np.int16).reshape(3, 4, 5) - 30) * 101
    tifffile.imwrite(f"{out}/stack-lzw-int16.tif", signed, compression="lzw", photometric="minisblack")
    floats = (np.arange(3 * 4 * 5, dtype=np.float32).reshape(3, 4, 5) / 7).astype(np.float32)
    tifffile.imwrite(f"{out}/stack-imagej-float32.tif", floats, imagej=True, resolution=(1 / 0.8, 1 / 0.8),
                     metadata={"axes": "TYX", "finterval": 0.5, "unit": "um"})
    rgb = np.zeros((4, 5, 3), dtype=np.uint8)
    tifffile.imwrite(f"{out}/rgb-uint8.tif", rgb, photometric="rgb")
    # Two OME Image series in one file: 3 time points, then 2.
    with tifffile.TiffWriter(f"{out}/two-series.ome.tif", ome=True) as tif:
        tif.write(ramp, metadata={"axes": "TYX"})
        tif.write(ramp[:2], metadata={"axes": "TYX"})


if __name__ == "__main__":
    main(sys.argv[1])
