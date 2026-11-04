"""Dump functional GIFTI files to the flat sidecars the Octave gifti shim reads.

Run with python3 -I. Needs only numpy and the standard library: the reader parses
the GIFTI XML itself (nibabel sits in the user site-packages, which -I excludes),
and it is independent of the Rust reader it serves as a check for.

For each <file>.gii it writes, under --out:
  <file>.gii.f32   every DataArray's float32 values in file order, little-endian,
                   so array t occupies bytes t * N * 4 .. (t + 1) * N * 4
  <file>.gii.json  {"file", "arrays", "vertices"}
and one --samples JSON with, per file, arrays, vertices and 256 (volume, vertex, value)
triples drawn with numpy RandomState(0), the value being the exact float32.
"""

import argparse
import base64
import json
import sys
import xml.etree.ElementTree as ElementTree
import zlib
from pathlib import Path

import numpy as np

SAMPLES = 256
EXPECTED = {
    "DataType": "NIFTI_TYPE_FLOAT32",
    "Encoding": "GZipBase64Binary",
    "Endian": "LittleEndian",
    "Dimensionality": "1",
}


def read_arrays(path):
    root = ElementTree.parse(path).getroot()
    arrays = []
    for element in root.iter("DataArray"):
        for key, value in EXPECTED.items():
            if element.get(key) != value:
                raise SystemExit(f"{path}: DataArray {key}={element.get(key)!r}, the dumper handles only {value}")
        count = int(element.get("Dim0"))
        raw = zlib.decompress(base64.b64decode(element.find("Data").text))
        values = np.frombuffer(raw, "<f4")
        if values.size != count:
            raise SystemExit(f"{path}: DataArray holds {values.size} values, Dim0 says {count}")
        arrays.append(values)
    if not arrays:
        raise SystemExit(f"{path}: no DataArray")
    if len({a.size for a in arrays}) != 1:
        raise SystemExit(f"{path}: DataArrays differ in length")
    return np.stack(arrays)


def sample(data):
    rng = np.random.RandomState(0)
    arrays, vertices = data.shape
    volumes = rng.randint(0, arrays, SAMPLES)
    indices = rng.randint(0, vertices, SAMPLES)
    return [
        {"volume": int(t), "vertex": int(v), "value": float(data[t, v])}
        for t, v in zip(volumes, indices)
    ]


def main(argv):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--samples", required=True, type=Path)
    parser.add_argument("gifti", nargs="+", type=Path)
    args = parser.parse_args(argv)
    args.out.mkdir(parents=True, exist_ok=True)
    reference = {}
    for path in args.gifti:
        data = read_arrays(path)
        arrays, vertices = data.shape
        (args.out / f"{path.name}.f32").write_bytes(data.astype("<f4").tobytes())
        (args.out / f"{path.name}.json").write_text(json.dumps({"file": path.name, "arrays": arrays, "vertices": vertices}) + "\n")
        reference[path.name] = {"arrays": arrays, "vertices": vertices, "samples": sample(data)}
        print(f"{path.name}: {arrays} arrays x {vertices} vertices")
    args.samples.write_text(json.dumps(reference, indent=1) + "\n")


if __name__ == "__main__":
    main(sys.argv[1:])
