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
palette = Image.fromarray(base % 4).convert("P")
palette.putpalette([0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255] + [0] * 756)
palette.save(out / "palette.png")
Image.fromarray(((base % 2) * 255).astype(np.uint8)).convert("1").save(out / "bits.png")
Image.fromarray(base.astype(np.uint16) * 200).save(out / "grey16.png")
for path in sorted(out.iterdir()):
    if path.suffix in (".tif", ".png"):
        print(path.name, path.stat().st_size)
