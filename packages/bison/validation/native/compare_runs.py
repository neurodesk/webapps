"""Compare two runs of run_native.sh for one subject.

Usage: python -I compare_runs.py <run-a>/<subject> <run-b>/<subject> [out.json]

For every file in both trees it reports the raw sha256 and a content hash:
  .mnc     voxel array bytes + size, origin, spacing, direction (SimpleITK); the
           MINC history attribute holds timestamps and paths, so raw hashes differ
  .xfm .imp  text without '%' comment lines, with runs/<name>/ replaced
  .nii.gz  voxel array bytes + affine (nibabel); gzip headers hold a timestamp
  .npy and other files: raw bytes
Logs, timings and the upstream QC images are skipped. For images whose content
differs it also gives the largest absolute difference and the count of differing voxels.
"""

import hashlib
import json
import os
import re
import sys
from pathlib import Path

import nibabel as nib
import numpy as np
import SimpleITK as sitk

SKIP_SUFFIX = (".txt", ".log", ".tsv", ".jpg", ".json", ".jsonl", ".csv", "done")


def file_sha(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def load(path, root):
    if path.endswith(".mnc"):
        img = sitk.ReadImage(path)
        a = sitk.GetArrayFromImage(img)
        meta = repr((img.GetOrigin(), img.GetSpacing(), img.GetDirection())).encode()
        return a, meta
    if path.endswith((".nii.gz", ".nii")):
        img = nib.load(path)
        a = np.asanyarray(img.dataobj)
        return a, img.affine.tobytes()
    if path.endswith((".xfm", ".imp")):
        lines = [
            ln for ln in Path(path).read_text().splitlines() if not ln.startswith("%")
        ]
        return None, re.sub(r"runs/[^/]+/", "runs/<run>/", "\n".join(lines)).encode()
    return None, None


def content_hash(path, root):
    a, meta = load(path, root)
    if a is None and meta is None:
        return file_sha(path), None
    h = hashlib.sha256(meta)
    if a is not None:
        h.update(str(a.dtype).encode() + str(a.shape).encode())
        h.update(np.ascontiguousarray(a).tobytes())
    return h.hexdigest(), a


def main():
    ra, rb = (os.path.realpath(p) for p in sys.argv[1:3])
    rel = set()
    for root in (ra, rb):
        for d, _, files in os.walk(root):
            if os.sep + "tmp" in d[len(root) :]:
                continue
            for f in files:
                if not f.endswith(SKIP_SUFFIX):
                    rel.add(os.path.relpath(os.path.join(d, f), root))
    report = {"a": ra, "b": rb, "files": {}}
    for r in sorted(rel):
        pa, pb = os.path.join(ra, r), os.path.join(rb, r)
        if not (os.path.exists(pa) and os.path.exists(pb)):
            report["files"][r] = {
                "status": "missing in " + ("b" if os.path.exists(pa) else "a")
            }
            continue
        sa, sb = file_sha(pa), file_sha(pb)
        ca, aa = content_hash(pa, ra)
        cb, ab = content_hash(pb, rb)
        entry = {
            "raw_equal": sa == sb,
            "content_equal": ca == cb,
            "sha256_a": sa,
            "sha256_b": sb,
        }
        if ca != cb and aa is not None and ab is not None and aa.shape == ab.shape:
            d = np.abs(aa.astype(np.float64) - ab.astype(np.float64))
            entry["max_abs_diff"] = float(d.max())
            entry["voxels_differ"] = int(np.count_nonzero(d))
        report["files"][r] = entry
    files = report["files"].values()
    report["summary"] = {
        "files": len(report["files"]),
        "raw_equal": sum(1 for e in files if e.get("raw_equal")),
        "content_equal": sum(1 for e in files if e.get("content_equal")),
        "content_differs": sorted(
            r for r, e in report["files"].items() if not e.get("content_equal")
        ),
    }
    text = json.dumps(report, indent=2)
    if len(sys.argv) > 3:
        Path(sys.argv[3]).write_text(text + "\n")
    print(json.dumps(report["summary"], indent=2))


if __name__ == "__main__":
    main()
