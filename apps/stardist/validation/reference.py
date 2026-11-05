"""Record Python StarDist's results on the example as the app's reference.

Run once in the environment described in convert_model.py, after it:

    python -I reference.py <model-dir> <img2d.tif> <mask2d.tif> <out.json> [browser-labels.tif ...]

<model-dir> holds the extracted 2D_versatile_fluo folder written by
convert_model.py. The script writes reference.json, which the unit tests and
the browser test read:

- normalization: csbdeep normalize(img, 1, 99.8) percentiles of the example
- percentiles: numpy percentiles of a deterministic array, for the unit test
- tiling: csbdeep tile_iterator_1d slices for several sizes and tile counts
- nms: a crop's candidates, StarDist's surviving indices and label image hash
- example: predict_instances with n_tiles (1, 1) and (2, 2): the surviving
  polygons, the label image hash, per-nucleus statistics and matching scores

Any browser label TIFF given after out.json is matched against the
reference with stardist.matching (IoU 0.5) and the scores are printed.
"""

import base64
import hashlib
import json
import sys
from pathlib import Path

import numpy as np
import tifffile
from csbdeep.internals.predict import Tiling
from csbdeep.utils import normalize
from skimage.measure import regionprops
from stardist.geometry import polygons_to_label
from stardist.matching import matching
from stardist.models import StarDist2D
from stardist.nms import non_maximum_suppression_sparse

PMIN, PMAX = 1, 99.8
CROP = (slice(160, 320), slice(96, 256))


def f32(values):
    return base64.b64encode(np.ascontiguousarray(values, "<f4").tobytes()).decode()


def i32(values):
    return base64.b64encode(np.ascontiguousarray(values, "<i4").tobytes()).decode()


def label_hash(labels):
    return hashlib.sha256(np.ascontiguousarray(labels, "<i4").tobytes()).hexdigest()


def tiling_cases(model):
    overlap = int(np.ceil(model._axes_tile_overlap("YX")[0] / 16))
    cases = []
    for n in (512, 784, 1040, 2048, 3008):
        for n_tiles in (1, 2, 3, 4, 7):
            tiling = Tiling.for_n_tiles(n // 16, n_tiles, overlap)
            tiles = [
                {"read": [read.start, read.stop], "crop": [crop.start, crop.stop], "write": [write.start, write.stop]}
                for read, write, crop in tiling.slice_generator(16)
            ]
            cases.append({"size": n, "n_tiles": n_tiles, "block": 16, "overlap_blocks": overlap, "tiles": tiles})
    return cases


def nucleus_table(labels, image):
    rows = []
    for region in regionprops(labels, intensity_image=image.astype(np.float64)):
        cy, cx = region.centroid
        rows.append([int(region.label), float(cx), float(cy), int(region.area), float(region.intensity_mean)])
    return rows


def main(model_dir, image_path, mask_path, out_path, *browser):
    model_dir = Path(model_dir)
    model = StarDist2D(None, name=model_dir.name, basedir=str(model_dir.parent))
    image = tifffile.imread(image_path)
    truth = tifffile.imread(mask_path)
    x = normalize(image, PMIN, PMAX)
    mi, ma = np.percentile(image, PMIN), np.percentile(image, PMAX)

    probe = (np.arange(10007, dtype=np.int64) * 7919 % 65521).astype(np.uint16)
    percentiles = {p: float(np.percentile(probe, p)) for p in (0, 1, 3, 50, 99.8, 100)}

    crop = x[CROP]
    prob, dist, points = model.predict_sparse(crop)
    kept_points, kept_prob, kept_dist, kept = non_maximum_suppression_sparse(dist, prob, points, nms_thresh=model.thresholds.nms)
    crop_labels = polygons_to_label(kept_dist, kept_points, prob=kept_prob, shape=crop.shape)
    nms = {
        "crop": [[CROP[0].start, CROP[0].stop], [CROP[1].start, CROP[1].stop]],
        "count": int(len(prob)),
        "prob": f32(prob),
        "dist": f32(dist),
        "points": i32(points),
        "kept": [int(i) for i in kept],
        "labels_sha256": label_hash(crop_labels),
    }

    example = {}
    results = {}
    for n_tiles in ((1, 1), (2, 2)):
        labels, details = model.predict_instances(x, n_tiles=n_tiles, show_tile_progress=False)
        key = f"{n_tiles[0]}x{n_tiles[1]}"
        results[key] = labels
        example[key] = {"n_tiles": list(n_tiles), "count": int(labels.max()), "labels_sha256": label_hash(labels)}
        if n_tiles == (1, 1):
            example[key].update(
                points=i32(details["points"]),
                prob=f32(details["prob"]),
                coord=f32(details["coord"]),
                nuclei=nucleus_table(labels, image),
            )
        score = matching(truth, labels, thresh=0.5)
        example[key]["vs_ground_truth"] = {"f1": float(score.f1), "precision": float(score.precision), "recall": float(score.recall), "n_true": int(score.n_true)}
    tiled = matching(results["1x1"], results["2x2"], thresh=0.5)
    example["2x2"]["vs_1x1"] = {"f1": float(tiled.f1), "mean_matched_iou": float(tiled.mean_matched_score)}

    reference = {
        "image_sha256": hashlib.sha256(Path(image_path).read_bytes()).hexdigest(),
        "shape": list(image.shape),
        "normalization": {"pmin": PMIN, "pmax": PMAX, "low": float(np.float32(mi)), "high": float(np.float32(ma))},
        "thresholds": {"prob": float(model.thresholds.prob), "nms": float(model.thresholds.nms)},
        "percentiles": percentiles,
        "tiling": tiling_cases(model),
        "nms": nms,
        "example": example,
    }
    Path(out_path).write_text(json.dumps(reference, indent=1) + "\n")
    for key in example:
        print(key, {k: v for k, v in example[key].items() if k in ("count", "labels_sha256", "vs_ground_truth", "vs_1x1")})
    for path in browser:
        labels = tifffile.imread(path)
        for key, want in results.items():
            score = matching(want, labels, thresh=0.5)
            same = np.array_equal(want, labels)
            print(path, key, {"f1": score.f1, "n_true": score.n_true, "n_pred": score.n_pred, "mean_matched_iou": score.mean_matched_score, "identical": bool(same)})


if __name__ == "__main__":
    main(*sys.argv[1:])
