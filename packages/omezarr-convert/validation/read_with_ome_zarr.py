"""Read a converter output with ome-zarr-py and zarr-python, as a third-party reader would.

    python -I read_with_ome_zarr.py output.ozx-unpacked-dir example-reference.json

Prints the NGFF version ome-zarr-py detects, each level's shape and whether its pixels equal
the reference sha256 of the method recorded in the multiscales `type`.
"""
import hashlib
import json
import sys

import numpy as np
from ome_zarr.io import parse_url
from ome_zarr.reader import Multiscales, Reader

path, reference_path = sys.argv[1:]
reference = json.load(open(reference_path))
location = parse_url(path)
node = next(iter(Reader(location)()))
spec = next(s for s in node.specs if isinstance(s, Multiscales))
method = spec.lookup("multiscales", [{}])[0]["type"]
print("ome-zarr-py version", location.version, "type", method, "channels", node.metadata.get("channel_names"))
for level, data in enumerate(node.data):
    array = np.asarray(data)
    digest = hashlib.sha256(np.ascontiguousarray(array).tobytes()).hexdigest()
    print(" level", level, array.shape, array.dtype, "equal" if digest == reference[method][level]["sha256"] else "DIFFERENT")
