"""Writes the colour TIFF fixtures of test/tiff-colour.test.js with tifffile (2024.2.12).

    python -I make_colour_tiff_fixtures.py <fixtures directory>
"""
import sys

import numpy as np
import tifffile


def ramp(height, width, dtype, scale):
    values = np.arange(height * width * 3).reshape(height, width, 3) * scale
    return values.astype(dtype)


def main(out):
    # 8-bit RGB, deflate, 300 dpi: 84.666… µm pixels.
    tifffile.imwrite(f"{out}/colour-rgb-deflate-uint8.tif", ramp(4, 5, np.uint8, 4), photometric="rgb",
                     compression="zlib", resolution=(300, 300), resolutionunit="INCH", metadata=None)
    # 16-bit RGB with an unassociated alpha sample and pixels given per centimetre.
    rgba = np.concatenate([ramp(3, 4, np.uint16, 1000), np.full((3, 4, 1), 65535, np.uint16)], axis=2)
    tifffile.imwrite(f"{out}/colour-rgba-uint16.tif", rgba, photometric="rgb", extrasamples=["unassalpha"],
                     resolution=(500, 400), resolutionunit="CENTIMETER", metadata=None)
    # Three greyscale samples per pixel (a channel stack, not RGB).
    tifffile.imwrite(f"{out}/colour-minisblack-3samples.tif", ramp(4, 5, np.uint8, 1), photometric="minisblack",
                     planarconfig="contig", metadata=None)
    # An 8-bit palette image whose colour map sends index i to (i, 2i, 3i) in 16-bit units.
    indices = (np.arange(20).reshape(4, 5) % 4).astype(np.uint8)
    colourmap = np.zeros((3, 256), np.uint16)
    for i in range(256):
        colourmap[:, i] = [i * 257 // 4, min(65535, 2 * i * 257 // 4), min(65535, 3 * i * 257 // 4)]
    tifffile.imwrite(f"{out}/colour-palette-uint8.tif", indices, photometric="palette", colormap=colourmap, metadata=None)
    # White-is-zero greyscale.
    tifffile.imwrite(f"{out}/colour-miniswhite-uint8.tif", (np.arange(20).reshape(4, 5) * 10).astype(np.uint8),
                     photometric="miniswhite", metadata=None)
    # A full-resolution RGB page followed by a reduced-resolution page.
    with tifffile.TiffWriter(f"{out}/colour-rgb-reduced.tif") as tif:
        tif.write(ramp(4, 6, np.uint8, 2), photometric="rgb", metadata=None)
        tif.write(ramp(2, 3, np.uint8, 2), photometric="rgb", subfiletype=1, metadata=None)
    # Two full-resolution RGB pages: a stack, not one section.
    with tifffile.TiffWriter(f"{out}/colour-rgb-two-pages.tif") as tif:
        tif.write(ramp(4, 5, np.uint8, 1), photometric="rgb", metadata=None)
        tif.write(ramp(4, 5, np.uint8, 2), photometric="rgb", metadata=None)
    # An RGB OME-TIFF with its physical pixel size.
    tifffile.imwrite(f"{out}/colour-rgb.ome.tif", ramp(4, 5, np.uint8, 3), photometric="rgb", ome=True,
                     metadata={"axes": "YXS", "PhysicalSizeX": 2.5, "PhysicalSizeXUnit": "µm",
                               "PhysicalSizeY": 2500, "PhysicalSizeYUnit": "nm"})
    # CMYK (separated) pixels: pure red, pure green and black, at 8 and at 16 bits.
    for dtype in (np.uint8, np.uint16):
        top = np.iinfo(dtype).max
        cmyk = np.array([[[0, top, top, 0], [top, 0, top, 0], [0, 0, 0, top]]], dtype)
        tifffile.imwrite(f"{out}/colour-cmyk-uint{8 * np.dtype(dtype).itemsize}.tif", cmyk,
                         photometric="separated", metadata=None)


if __name__ == "__main__":
    main(sys.argv[1])
