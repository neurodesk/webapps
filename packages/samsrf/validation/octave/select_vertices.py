"""Choose the vertex subset the preprocessing reference is dumped for.

Run with python3 -I. Reads a FreeSurfer label whose first column may index both
hemispheres (SamSrf's bilateral V123.label puts the left hemisphere first), keeps the
rows below --vertices, adds --extra other vertices drawn with numpy RandomState(0),
and writes {"vertices", "label", "roi", "subset"} with sorted 0-based indices.
"""

import argparse
import json
import sys
from pathlib import Path

import numpy as np


def main(argv):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--label", required=True, type=Path)
    parser.add_argument("--gifti-json", required=True, type=Path, help="a <file>.gii.json from dump_gifti.py, for the vertex count")
    parser.add_argument("--extra", type=int, default=512)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args(argv)
    vertices = json.loads(args.gifti_json.read_text())["vertices"]
    rows = np.loadtxt(args.label, skiprows=2, ndmin=2)
    roi = np.unique(rows[:, 0].astype(np.int64))
    roi = roi[roi < vertices]
    others = np.setdiff1d(np.arange(vertices), roi)
    extra = np.random.RandomState(0).choice(others, args.extra, replace=False)
    subset = np.union1d(roi, extra)
    args.out.write_text(json.dumps({
        "vertices": vertices,
        "label": args.label.name,
        "roi": roi.tolist(),
        "subset": subset.tolist(),
    }) + "\n")
    print(f"{args.label.name}: {roi.size} hemisphere vertices, subset of {subset.size}")


if __name__ == "__main__":
    main(sys.argv[1:])
