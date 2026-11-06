"""Record Big-FISH reference results for the spot-detection app.

Run once in a venv with big-fish 0.6.2 (see README.md, "Validation"):

    python -I bigfish_reference.py --out reference.json [--example DIR]

Synthetic cases come from the integer generator in ``synthetic.py``, which
``src/synthetic.js`` reproduces exactly, so the Node tests compare against
these numbers without any data file. With ``--example``, the Big-FISH example
stack (experiment_1_smfish_fov_1.tif) and the cell labels made by
``make_cell_labels.py`` are run too.
"""
import argparse
import hashlib
import json
import os
import sys

import numpy as np
import bigfish
import bigfish.stack as stack
import bigfish.detection as detection
from bigfish.detection.spot_detection import _get_candidate_thresholds, _get_spot_counts
from bigfish.detection.utils import get_breaking_point

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from synthetic import synthetic_image  # noqa: E402


def run_case(image, voxel_size, spot_radius, cells=None, curve=False):
    ndim = image.ndim
    sigma = detection.get_object_radius_pixel(voxel_size, spot_radius, ndim)
    log = stack.log_filter(image, sigma)
    mask = detection.local_maximum_detection(log, sigma)
    thresholds, counts, elbow = detection.get_elbow_values(
        image, voxel_size=voxel_size, spot_radius=spot_radius)
    spots, threshold = detection.detect_spots(
        image, return_threshold=True, voxel_size=voxel_size, spot_radius=spot_radius)
    assert threshold == elbow
    subpixel = detection.fit_subpixel(image, spots, voxel_size, spot_radius)
    out = {
        "shape": list(image.shape),
        "voxelSize": list(voxel_size),
        "spotRadius": list(spot_radius),
        "sigma": list(sigma),
        "logSha256": hashlib.sha256(log.astype("<u2").tobytes()).hexdigest(),
        "localMaxima": int(mask.sum()),
        "candidateThresholds": int(_get_candidate_thresholds(log.ravel()).size),
        "curveLength": int(len(counts)),
        "threshold": float(threshold),
        "spots": spots.tolist(),
        "intensity": [int(image[tuple(s)]) for s in spots],
        "subpixel": np.round(subpixel, 9).tolist(),
    }
    if curve:
        out["curve"] = {"thresholds": thresholds.tolist(), "counts": counts.tolist()}
    if cells is not None:
        ids = cells[spots[:, -2], spots[:, -1]]
        labels = np.unique(cells)
        labels = labels[labels > 0]
        out["cells"] = [[int(l), int(np.count_nonzero(ids == l)), int(np.count_nonzero(cells == l))] for l in labels]
        out["spotsOutsideCells"] = int(np.count_nonzero(ids == 0))
    return out


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True)
    parser.add_argument("--example")
    args = parser.parse_args()
    cases = {}
    for name, shape, n, seed, voxel, radius in [
        ("synthetic-3d", (12, 64, 72), 40, 7, (300, 103, 103), (350, 150, 150)),
        ("synthetic-2d", (96, 80), 30, 11, (103, 103), (150, 150)),
        ("synthetic-2d-fine", (64, 64), 12, 3, (100, 100), (90, 90)),
    ]:
        image = synthetic_image(shape, n, seed)
        cases[name] = {"generator": {"shape": list(shape), "spots": n, "seed": seed},
                       **run_case(image, voxel, radius, curve=True)}
    if args.example:
        rna = stack.read_image(os.path.join(args.example, "experiment_1_smfish_fov_1.tif"))
        cells = stack.read_image(os.path.join(args.example, "experiment_1_cell_label.tif"))
        voxel, radius = (300, 103, 103), (350, 150, 150)
        cases["example-3d"] = run_case(rna, voxel, radius, cells=cells)
        cases["example-mip-2d"] = run_case(stack.maximum_projection(rna), voxel[1:], radius[1:], cells=cells)
    versions = {"big-fish": bigfish.__version__, "numpy": np.__version__}
    import scipy, skimage
    versions.update({"scipy": scipy.__version__, "scikit-image": skimage.__version__})
    with open(args.out, "w") as f:
        json.dump({"versions": versions, "cases": cases}, f, separators=(",", ":"))
        f.write("\n")


if __name__ == "__main__":
    main()
