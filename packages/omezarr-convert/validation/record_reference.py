"""Record the example's reference: bioformats2raw's conversion, read by zarr-python.

Run once (see README.md, "Validation"):

    python -I record_reference.py retina-crop.ome.tif b2r-SIMPLE-0.4.zarr b2r-SIMPLE-0.5.zarr > example-reference.json

bioformats2raw 0.14.0 (Bio-Formats 9.0.0-rc2) was run with
`--downsample-type=SIMPLE -w 256 -h 256 --target-min-size=256` and `-c zlib` for 0.4,
`-c gzip` for 0.5. The record holds, per NGFF version, bioformats2raw's multiscales and
omero metadata and, per pyramid level, the array shape, chunks, data type and the sha256 of
the decoded array (C order). It adds the sha256 of the 2 x 2 block-mean pyramid computed
here with numpy from the source pixels (tifffile), the method the converter calls `mean`,
which bioformats2raw has no equivalent of (its AREA scaler is OpenCV's fractional resize).
"""
import hashlib
import json
import sys

import numpy as np
import tifffile
import zarr


def sha256(array):
    return hashlib.sha256(np.ascontiguousarray(array).tobytes()).hexdigest()


def mean_pyramid(planes, levels):
    """planes: (..., y, x) integer array. Round half up, floor sizes, as src/pyramid.js says."""
    out = [planes]
    for _ in range(1, levels):
        a = out[-1].astype(np.int64)
        h, w = a.shape[-2] // 2, a.shape[-1] // 2
        a = a[..., : 2 * h, : 2 * w]
        s = a[..., 0::2, 0::2] + a[..., 1::2, 0::2] + a[..., 0::2, 1::2] + a[..., 1::2, 1::2]
        out.append(((s + 2) // 4).astype(planes.dtype))
    return out


def record(path):
    root = zarr.open_group(path, mode="r")
    image = root["0"]
    attrs = dict(image.attrs)
    attrs = attrs.get("ome", attrs)
    multiscales = attrs["multiscales"][0]
    levels = []
    for dataset in multiscales["datasets"]:
        array = image[dataset["path"]]
        levels.append({
            "path": dataset["path"],
            "shape": list(array.shape),
            "chunks": list(array.chunks),
            "dtype": str(array.dtype),
            "sha256": sha256(array[...]),
        })
    return {"multiscales": multiscales, "omero": attrs.get("omero"), "levels": levels}


def main():
    source, *outputs = sys.argv[1:]
    with tifffile.TiffFile(source) as tif:
        pixels = tif.series[0].asarray()[np.newaxis]  # t, c, z, y, x
    reference = {"source": {"shape": list(pixels.shape), "dtype": str(pixels.dtype), "sha256": sha256(pixels)}}
    for path in outputs:
        entry = record(path)
        version = entry["multiscales"].get("version") or "0.5"
        reference[version] = entry
    levels = len(reference["0.4"]["levels"])
    reference["mean"] = [{"shape": list(level.shape), "sha256": sha256(level)} for level in mean_pyramid(pixels, levels)]
    reference["nearest"] = [{"shape": list(pixels[..., :: 2**k, :: 2**k][..., : s["shape"][3], : s["shape"][4]].shape),
                             "sha256": sha256(pixels[..., :: 2**k, :: 2**k][..., : s["shape"][3], : s["shape"][4]])}
                            for k, s in enumerate(reference["0.4"]["levels"])]
    json.dump(reference, sys.stdout, indent=2)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
