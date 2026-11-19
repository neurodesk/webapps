#!/usr/bin/env python3
"""Pack fsaverage cortical parcellations for TopoFit region search.

Writes fsaverage-regions.bin: a little-endian uint32 vertex count, then one uint8
label per fsaverage vertex for each atlas in ATLASES, left hemisphere before right.
The vertices are in the order of fsaverage-cortex.bin, whose single sphere serves
both hemispheres: fsaverage's lh.sphere.reg and rh.sphere.reg are the same
icosahedron, which this script checks. Downloads stay outside the repository.
"""
import argparse
import hashlib
import json
from pathlib import Path
import struct
import urllib.request
import zipfile
import nibabel as nib
import numpy as np

FREESURFER = "https://www.freesurfer.net/pub/dist/freesurfer/tutorial_versions_centos6/freesurfer/subjects/fsaverage/"
WANG_ZIP = "https://osf.io/download/rne5b/"
SOURCES = {
    "lh.sphere.reg": (FREESURFER + "surf/lh.sphere.reg", "fddcf0eeecc6e0f62142164f7c0ac24fda1f0be8cb653d3f037970184c5ba98f"),
    "rh.sphere.reg": (FREESURFER + "surf/rh.sphere.reg", "fddcf0eeecc6e0f62142164f7c0ac24fda1f0be8cb653d3f037970184c5ba98f"),
    "lh.aparc.annot": (FREESURFER + "label/lh.aparc.annot", "39b1acde9a32b4227631eb51cbcd8dff84e2138c57bf9f96d74026f2c17f1480"),
    "rh.aparc.annot": (FREESURFER + "label/rh.aparc.annot", "6a326aed325d313e6e0d10f67630efcd8d3b8343c50d3e108e005f626614badb"),
    "atlasmgz.zip": (WANG_ZIP, "025e60cd646028f28c79c8606d6b47395509db612232137270bbe65713fd0e91"),
}
# Only these members are read; the zip's Glasser2016 files carry HCP data-use terms.
WANG_MEMBERS = {
    "lh.Wang2015.mgz": "029d1c3617082abfc1ddc15057cff287eb190e343851e2b7b6cb058708f6f66a",
    "rh.Wang2015.mgz": "bab9b7497e606218b752dce5c7f300fcc148a7c98770498615c7d641587044da",
    "Wang2015.mgz.ctab": "a003fdb45a9f4f7dd4f366d1d50439fe3b6e95204045e39bc012bb59af6cbbdc",
}
# Wang2015.mgz.ctab has names only. Display colours, one per label, all distinct.
WANG_RGB = [
    [0, 0, 0], [230, 25, 75], [250, 90, 120], [245, 130, 48], [255, 180, 110],
    [255, 225, 25], [255, 240, 140], [60, 180, 75], [120, 210, 120], [0, 128, 64],
    [70, 240, 240], [0, 150, 160], [0, 130, 200], [100, 170, 255], [145, 30, 180],
    [200, 120, 230], [240, 50, 230], [250, 170, 240], [128, 0, 0], [170, 110, 40],
    [128, 128, 0], [0, 0, 128], [128, 128, 128], [210, 245, 60], [170, 255, 195],
    [255, 215, 180],
]
ATLASES = ("wang2015", "aparc")


def fetch(directory, name):
    url, digest = SOURCES[name]
    target = directory / name
    if not target.exists():
        urllib.request.urlretrieve(url, target)
    if hashlib.sha256(target.read_bytes()).hexdigest() != digest:
        raise ValueError(f"Checksum mismatch: {name}")
    return target


def wang(directory):
    with zipfile.ZipFile(fetch(directory, "atlasmgz.zip")) as archive:
        for name, digest in WANG_MEMBERS.items():
            data = archive.read(f"atlasmgz/{name}")
            if hashlib.sha256(data).hexdigest() != digest:
                raise ValueError(f"Checksum mismatch: {name}")
            (directory / name).write_bytes(data)
    names = []
    for line in (directory / "Wang2015.mgz.ctab").read_text().splitlines():
        value, name = line.split()
        if int(value) != len(names):
            raise ValueError("Wang2015.mgz.ctab is not numbered consecutively from 0.")
        names.append(name)
    hemispheres = []
    for hemisphere in ("lh", "rh"):
        values = np.asarray(nib.load(str(directory / f"{hemisphere}.Wang2015.mgz")).dataobj, dtype=np.float64).ravel()
        values = np.nan_to_num(values, nan=0)
        if np.any(values != np.round(values)) or values.min() < 0 or values.max() >= len(names):
            raise ValueError(f"{hemisphere}.Wang2015.mgz has values outside its colour table.")
        hemispheres.append(values.astype(np.uint8))
    labels = [{"value": i, "name": name, "rgb": WANG_RGB[i]} for i, name in enumerate(names)]
    return labels, hemispheres


def aparc(directory):
    hemispheres = []
    tables = []
    for hemisphere in ("lh", "rh"):
        values, ctab, names = nib.freesurfer.read_annot(str(fetch(directory, f"{hemisphere}.aparc.annot")))
        tables.append([{"value": i, "name": name.decode(), "rgb": ctab[i, :3].tolist()} for i, name in enumerate(names)])
        # -1 marks vertices whose colour is not in the table (the medial wall): store as unknown, 0.
        hemispheres.append(np.maximum(values, 0).astype(np.uint8))
    if tables[0] != tables[1]:
        raise ValueError("Left and right aparc colour tables differ.")
    return tables[0], hemispheres


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    args = parser.parse_args()
    args.directory.mkdir(parents=True, exist_ok=True)
    left, _ = nib.freesurfer.read_geometry(str(fetch(args.directory, "lh.sphere.reg")))
    right, _ = nib.freesurfer.read_geometry(str(fetch(args.directory, "rh.sphere.reg")))
    if not np.array_equal(left, right):
        raise ValueError("fsaverage hemispheres do not share one sphere; fsaverage-cortex.bin cannot serve both.")
    atlases = {"wang2015": wang(args.directory), "aparc": aparc(args.directory)}
    packed = struct.pack("<I", len(left))
    for atlas in ATLASES:
        _, hemispheres = atlases[atlas]
        for values in hemispheres:
            if len(values) != len(left):
                raise ValueError(f"{atlas} does not have one label per fsaverage vertex.")
            packed += values.tobytes()
    (args.directory / "fsaverage-regions.bin").write_bytes(packed)
    print(json.dumps({
        "filename": "fsaverage-regions.bin",
        "bytes": len(packed),
        "sha256": hashlib.sha256(packed).hexdigest(),
        "vertices": len(left),
        "sources": {name: list(source) for name, source in SOURCES.items()},
        "wang2015_members": WANG_MEMBERS,
        "labels": {atlas: atlases[atlas][0] for atlas in ATLASES},
    }, indent=2))


if __name__ == "__main__":
    main()
