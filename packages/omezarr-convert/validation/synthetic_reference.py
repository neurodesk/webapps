"""Pyramids of the synthetic images in test/writer.test.js, computed with numpy.

    python -I synthetic_reference.py > ../test/synthetic-reference.json

An implementation of the two downsampling methods independent of src/pyramid.js:
`nearest` is array[..., ::2, ::2] cropped to floor(n / 2) (bioformats2raw's SIMPLE scaler,
which this matches on the example); `mean` averages each 2 x 2 block (2 x 1 or 1 x 2 when a
side is 1), integer types rounding halves up, floats summed in float64 in the order
a[0,0] + a[0,1] + a[1,0] + a[1,1] and stored in their own precision. Levels halve Y and X
while the larger of the two exceeds the target. The record is the sha256 of each level's
C-order bytes.
"""
import hashlib
import json
import sys

import numpy as np

CASES = [
    {"id": "uint8", "dtype": "uint8", "shape": [1, 2, 2, 19, 23], "target": 8},
    {"id": "int8", "dtype": "int8", "shape": [1, 1, 2, 19, 23], "target": 8},
    {"id": "uint16", "dtype": "uint16", "shape": [2, 3, 3, 37, 53], "target": 16},
    {"id": "int16", "dtype": "int16", "shape": [1, 2, 1, 37, 53], "target": 16},
    {"id": "uint32", "dtype": "uint32", "shape": [1, 1, 2, 21, 17], "target": 8},
    {"id": "int32", "dtype": "int32", "shape": [1, 1, 2, 21, 17], "target": 8},
    {"id": "float32", "dtype": "float32", "shape": [1, 2, 2, 33, 31], "target": 16},
    {"id": "float64", "dtype": "float64", "shape": [1, 1, 1, 33, 31], "target": 16},
    {"id": "row", "dtype": "uint16", "shape": [1, 1, 1, 1, 40], "target": 4},
    {"id": "column", "dtype": "int16", "shape": [1, 1, 1, 41, 1], "target": 4},
]


def synthetic(dtype, shape):
    """value(t, c, z, y, x) as test/writer.test.js computes it."""
    t, c, z, y, x = np.meshgrid(*[np.arange(n, dtype=np.int64) for n in shape], indexing="ij")
    raw = (t * 7919 + c * 104729 + z * 1299709 + y * 31 + x * 17 + (y * x) % 13) % 1000003
    if dtype.startswith("float"):
        return (raw.astype(np.float64) / 7.0 - 50000.0).astype(dtype)
    info = np.iinfo(dtype)
    span = int(info.max) - int(info.min) + 1
    return ((raw * 2654435761) % span + int(info.min)).astype(dtype)


def downsample(a, method):
    h, w = a.shape[-2:]
    oh, ow = max(1, h // 2), max(1, w // 2)
    if method == "nearest":
        return a[..., ::2, ::2][..., :oh, :ow]
    rows = 2 if h > 1 else 1
    cols = 2 if w > 1 else 1
    wide = a.astype(np.float64) if a.dtype.kind == "f" else a.astype(np.int64)
    blocks = [wide[..., dy::2, dx::2][..., :oh, :ow] for dy in range(rows) for dx in range(cols)]
    total = blocks[0]
    for b in blocks[1:]:
        total = total + b
    n = rows * cols
    if a.dtype.kind == "f":
        return (total / n).astype(a.dtype)
    return np.floor_divide(total + n // 2, n).astype(a.dtype)


def pyramid(a, method, target):
    levels = [a]
    while max(levels[-1].shape[-2:]) > target:
        levels.append(downsample(levels[-1], method))
    return levels


def main():
    out = []
    for case in CASES:
        a = synthetic(case["dtype"], case["shape"])
        entry = {**case, "source": hashlib.sha256(a.tobytes()).hexdigest()}
        for method in ("nearest", "mean"):
            entry[method] = [{"shape": list(level.shape), "sha256": hashlib.sha256(np.ascontiguousarray(level).tobytes()).hexdigest()} for level in pyramid(a, method, case["target"])]
        out.append(entry)
    json.dump(out, sys.stdout, indent=2)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
