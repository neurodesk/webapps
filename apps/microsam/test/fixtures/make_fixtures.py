"""Small TIFF and PNG files for test/image-io.test.js. python -I make_fixtures.py <out-dir>"""
import sys
from pathlib import Path

import numpy as np
import tifffile
from PIL import Image

out = Path(sys.argv[1])
y, x = np.mgrid[0:12, 0:10]
base = (x * 7 + y * 3).astype(np.uint8)

tifffile.imwrite(out / "rgb.tif", np.stack([base, base + 1, base + 2], -1), photometric="rgb")
tifffile.imwrite(out / "rgba.tif", np.stack([base, base + 1, base + 2, np.full_like(base, 255)], -1), photometric="rgb", extrasamples=["unassalpha"])
tifffile.imwrite(out / "two-samples.tif", np.stack([base, base + 5], -1), photometric="minisblack", planarconfig="contig", extrasamples=["unspecified"])
tifffile.imwrite(out / "uint16.tif", (base.astype(np.uint16) * 300), photometric="minisblack")
nan = base.astype(np.float32)
nan[3, 4] = np.nan
tifffile.imwrite(out / "nan.tif", nan, photometric="minisblack")
channels = np.stack([base, base * 2], 0).astype(np.uint16)
tifffile.imwrite(out / "two-channels.ome.tif", channels, photometric="minisblack", metadata={"axes": "CYX", "Channel": {"Name": ["DAPI", "GFP & co"]}}, ome=True)
tifffile.imwrite(out / "stack.ome.tif", np.stack([base, base, base], 0), photometric="minisblack", metadata={"axes": "ZYX"}, ome=True)
tifffile.imwrite(out / "hyperstack.tif", np.stack([base, base], 0), imagej=True, metadata={"axes": "CYX"})
tifffile.imwrite(out / "zstack-imagej.tif", np.stack([base, base], 0), imagej=True, metadata={"axes": "ZYX"})
# An RGB page with an unspecified sample and an alpha, in both orders.
extras = np.stack([base, base + 1, base + 2, base + 3, np.full_like(base, 255)], -1)
tifffile.imwrite(out / "extras-0-2.tif", extras, photometric="rgb", extrasamples=["unspecified", "unassalpha"])
tifffile.imwrite(out / "extras-2-0.tif", extras[..., [0, 1, 2, 4, 3]], photometric="rgb", extrasamples=["unassalpha", "unspecified"])
# OME-XML whose TiffData puts DAPI (base) in IFD 1 and GFP (base * 2) in IFD 0.
mapped = (
    '<?xml version="1.0"?><OME xmlns="http://www.openmicroscopy.org/Schemas/OME/2016-06"><Image ID="Image:0">'
    '<Pixels ID="Pixels:0" DimensionOrder="XYCZT" Type="uint8" SizeX="10" SizeY="12" SizeZ="1" SizeC="2" SizeT="1">'
    '<Channel ID="Channel:0:0" Name="DAPI" SamplesPerPixel="1"/><Channel ID="Channel:0:1" Name="GFP" SamplesPerPixel="1"/>'
    '<TiffData IFD="1" FirstC="0" FirstZ="0" FirstT="0" PlaneCount="1"/><TiffData IFD="0" FirstC="1" FirstZ="0" FirstT="0" PlaneCount="1"/>'
    "</Pixels></Image></OME>"
)
with tifffile.TiffWriter(out / "mapped.ome.tif") as tif:
    tif.write(base * 2, photometric="minisblack", description=mapped, metadata=None)
    tif.write(base, photometric="minisblack", metadata=None)
palette = Image.fromarray(base % 4).convert("P")
palette.putpalette([0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255] + [0] * 756)
palette.save(out / "palette.png")
Image.fromarray(((base % 2) * 255).astype(np.uint8)).convert("1").save(out / "bits.png")
Image.fromarray(base.astype(np.uint16) * 200).save(out / "grey16.png")
# An 8-bit image saved with Fiji's Blue LUT: a palette page whose index k is blue k * 80.
blue = np.zeros((3, 256), dtype=np.uint16)
blue[2] = np.minimum(np.arange(256) * 80, 255) * 257
tifffile.imwrite(out / "palette-blue.tif", base % 4, photometric="palette", colormap=blue)
for path in sorted(out.iterdir()):
    if path.suffix in (".tif", ".png"):
        print(path.name, path.stat().st_size)
