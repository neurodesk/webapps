"""Write the small TIFF fixtures test/microscopy-tiff.test.js reads (tifffile, independent of
the reader under test). Run: python -I scripts/make_fixtures.py test/fixtures"""
import sys

import numpy as np
import tifffile

out = sys.argv[1]
stack = (np.arange(3 * 5 * 7, dtype=np.uint16).reshape(3, 5, 7) * 3 + 1)

# ImageJ hyperstack, deflate-compressed, 0.0659 x 0.0659 x 0.13 micron.
tifffile.imwrite(f"{out}/imagej-uint16.tif", stack, imagej=True, resolution=(1 / 0.0659, 1 / 0.0659),
                 metadata={"spacing": 0.13, "unit": "micron", "axes": "ZYX"}, compression="zlib")
# ImageJ with two channels: refused.
tifffile.imwrite(f"{out}/imagej-two-channels.tif", np.stack([stack, stack], axis=1), imagej=True, metadata={"axes": "ZCYX"})
# OME-TIFF float32 with nanometre sizes, then the same XML with an ome: namespace prefix.
ome = dict(axes="ZYX", PhysicalSizeX=65.9, PhysicalSizeXUnit="nm", PhysicalSizeY=65.9, PhysicalSizeYUnit="nm", PhysicalSizeZ=0.13, PhysicalSizeZUnit="µm")
tifffile.imwrite(f"{out}/ome-float32.ome.tif", stack.astype(np.float32) / 7, ome=True, metadata=ome)
with tifffile.TiffFile(f"{out}/ome-float32.ome.tif") as tif:
    xml = tif.ome_metadata
prefixed = xml.replace("<OME ", "<ome:OME xmlns:ome=\"http://www.openmicroscopy.org/Schemas/OME/2016-06\" ", 1).replace("</OME>", "</ome:OME>")
for tag in ("Image", "Pixels", "Channel", "TiffData", "Plane"):
    prefixed = prefixed.replace(f"<{tag} ", f"<ome:{tag} ").replace(f"<{tag}>", f"<ome:{tag}>").replace(f"</{tag}>", f"</ome:{tag}>")
with tifffile.TiffWriter(f"{out}/ome-prefixed.ome.tif") as writer:
    for z, plane in enumerate(stack.astype(np.float32) / 7):
        writer.write(plane, photometric="minisblack", description=prefixed.encode("utf-8") if z == 0 else None, metadata=None)
# Grayscale plus an alpha extra sample per page: the first sample is the intensity.
alpha = np.stack([stack.astype(np.uint8), np.full_like(stack, 255, dtype=np.uint8)], axis=-1)
tifffile.imwrite(f"{out}/gray-alpha.tif", alpha, photometric="minisblack", extrasamples=["unassalpha"], metadata=None)
# Three samples marked MinIsBlack with no extra samples: three channels, refused.
tifffile.imwrite(f"{out}/three-samples-minisblack.tif", np.stack([stack.astype(np.uint8)] * 3, axis=-1), photometric="minisblack", planarconfig="contig", metadata=None)
# RGB colour: refused.
tifffile.imwrite(f"{out}/rgb.tif", np.stack([stack.astype(np.uint8)] * 3, axis=-1), photometric="rgb", metadata=None)
# WhiteIsZero 8-bit: inverted on read.
tifffile.imwrite(f"{out}/white-is-zero.tif", stack.astype(np.uint8), photometric="miniswhite", metadata=None)
# Plain TIFF with a centimetre resolution: 20000 px/cm = 0.5 micron pixels, no z calibration.
tifffile.imwrite(f"{out}/resolution-cm.tif", stack[:1], resolution=(20000, 20000), resolutionunit="CENTIMETER", metadata=None)
# ImageJ 8-bit stack with a colour lookup table, stored as Palette: indices are intensities.
lut = np.zeros((3, 256), dtype=np.uint8)
lut[0] = np.arange(256)
tifffile.imwrite(f"{out}/imagej-palette.tif", stack.astype(np.uint8), imagej=True, colormap=lut, metadata={"axes": "ZYX"})
# The same Palette pages without ImageJ metadata: indexed colour, refused.
tifffile.imwrite(f"{out}/palette.tif", stack.astype(np.uint8), photometric="palette", colormap=lut, metadata=None)
