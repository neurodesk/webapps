"""Record Python StarDist's results on all examples as the app's reference.

Run once in the environment described in convert_model.py, after it:

    python -I reference.py <models-dir> <out.json> [browser-labels.tif ...]

<models-dir> holds the extracted 2D_versatile_fluo, 2D_versatile_he,
2D_paper_dsb2018 and 3D_demo folders written by convert_model.py. The script
uses StarDist 0.9.1's built-in test images (test_image_nuclei_2d,
test_image_he_2d and test_image_nuclei_3d) and writes reference.json, which the
unit tests and the browser tests read.
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
from stardist.data import abspath, test_image_he_2d, test_image_nuclei_2d, test_image_nuclei_3d
from stardist.geometry import polygons_to_label
from stardist.matching import matching
from stardist.models import StarDist2D, StarDist3D
from stardist.nms import non_maximum_suppression_3d_sparse, non_maximum_suppression_sparse
from stardist.rays3d import rays_from_json

PMIN, PMAX = 1, 99.8
CROP = (slice(160, 320), slice(96, 256))
PADDED_CROP = (slice(160, 317), slice(96, 299))
PAD_SHAPES = ((157, 203), (5, 3), (16, 33), (1, 18))
PAD_3D_SHAPES = ((31, 61, 57), (5, 7, 9), (4, 8, 8))
SOURCE_2D = "https://huggingface.co/datasets/neurodeskorg/webapps/resolve/e76a7bbd831da2bfdae49058700da81d6cca577c/stardist/"
SOURCE_NEW = "https://huggingface.co/datasets/neurodeskorg/webapps/resolve/2cc5042a0fad34811857bbdf89b1172bda338af4/stardist/"


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


def padding_cases():
    cases = []
    for shape in PAD_SHAPES:
        values = np.arange(shape[0] * shape[1], dtype=np.float32).reshape(shape)
        pad = tuple((0, (16 - s % 16) % 16) for s in shape)
        padded = np.pad(values, pad, mode="reflect")
        cases.append({"shape": list(shape), "padded_shape": list(padded.shape), "sha256": hashlib.sha256(np.ascontiguousarray(padded, "<f4").tobytes()).hexdigest()})
    return cases


def padding_3d_cases(div_by):
    cases = []
    for shape in PAD_3D_SHAPES:
        values = np.arange(int(np.prod(shape)), dtype=np.float32).reshape(shape)
        pad = tuple((0, (d - s % d) % d) for s, d in zip(shape, div_by))
        padded = np.pad(values, pad, mode="reflect")
        cases.append({"shape": list(shape), "div_by": list(div_by), "padded_shape": list(padded.shape), "sha256": hashlib.sha256(np.ascontiguousarray(padded, "<f4").tobytes()).hexdigest()})
    return cases


def padded_crop_case(model, image):
    raw = image[PADDED_CROP]
    x = normalize(raw, PMIN, PMAX)
    prob, dist, points = model.predict_sparse(x)
    _, _, _, kept = non_maximum_suppression_sparse(dist, prob, points, nms_thresh=model.thresholds.nms)
    labels, _ = model.predict_instances(x, show_tile_progress=False)
    return {
        "crop": [[PADDED_CROP[0].start, PADDED_CROP[0].stop], [PADDED_CROP[1].start, PADDED_CROP[1].stop]],
        "raw_sha256": hashlib.sha256(np.ascontiguousarray(raw, "<u2").tobytes()).hexdigest(),
        "candidates": int(len(prob)),
        "prob": f32(prob),
        "dist": f32(dist),
        "points": i32(points),
        "kept": [int(i) for i in kept],
        "count": int(labels.max()),
        "labels_sha256": label_hash(labels),
    }


def nucleus_table_2d(labels, image):
    intensity = image.mean(axis=-1, dtype=np.float64) if image.ndim == 3 else image.astype(np.float64)
    rows = []
    for region in regionprops(labels, intensity_image=intensity):
        cy, cx = region.centroid
        rows.append([int(region.label), float(cx), float(cy), int(region.area), float(region.intensity_mean)])
    return rows


def nucleus_table_3d(labels, image):
    rows = []
    for region in regionprops(labels, intensity_image=image.astype(np.float64)):
        cz, cy, cx = region.centroid
        rows.append([int(region.label), float(cx), float(cy), float(cz), int(region.area), float(region.intensity_mean)])
    return rows


def main(models_dir, out_path, *browser):
    models_dir = Path(models_dir)
    fluo = StarDist2D(None, name="2D_versatile_fluo", basedir=str(models_dir))
    he_model = StarDist2D(None, name="2D_versatile_he", basedir=str(models_dir))
    paper = StarDist2D(None, name="2D_paper_dsb2018", basedir=str(models_dir))
    demo3d = StarDist3D(None, name="3D_demo", basedir=str(models_dir))

    image, truth = test_image_nuclei_2d(return_mask=True)
    image_path = Path(abspath("images/img2d.tif"))
    mask_path = Path(abspath("images/mask2d.tif"))
    x = normalize(image, PMIN, PMAX)
    mi, ma = np.percentile(image, PMIN), np.percentile(image, PMAX)

    probe = (np.arange(10007, dtype=np.int64) * 7919 % 65521).astype(np.uint16)
    percentiles = {p: float(np.percentile(probe, p)) for p in (0, 1, 3, 50, 99.8, 100)}

    crop = x[CROP]
    prob, dist, points = fluo.predict_sparse(crop)
    kept_points, kept_prob, kept_dist, kept = non_maximum_suppression_sparse(dist, prob, points, nms_thresh=fluo.thresholds.nms)
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
        labels, details = fluo.predict_instances(x, n_tiles=n_tiles, show_tile_progress=False)
        key = f"{n_tiles[0]}x{n_tiles[1]}"
        results[key] = labels
        example[key] = {"n_tiles": list(n_tiles), "count": int(labels.max()), "labels_sha256": label_hash(labels)}
        if n_tiles == (1, 1):
            example[key].update(
                points=i32(details["points"]),
                prob=f32(details["prob"]),
                coord=f32(details["coord"]),
                nuclei=nucleus_table_2d(labels, image),
            )
        score = matching(truth, labels, thresh=0.5)
        example[key]["vs_ground_truth"] = {"f1": float(score.f1), "precision": float(score.precision), "recall": float(score.recall), "n_true": int(score.n_true)}
    tiled = matching(results["1x1"], results["2x2"], thresh=0.5)
    example["2x2"]["vs_1x1"] = {"f1": float(tiled.f1), "mean_matched_iou": float(tiled.mean_matched_score)}

    # 2D_versatile_he on test_image_he_2d (RGB)
    he_img = test_image_he_2d()
    he_x = normalize(he_img, PMIN, PMAX, axis=(0, 1, 2))
    he_mi, he_ma = np.percentile(he_img, PMIN), np.percentile(he_img, PMAX)
    he_labels, _ = he_model.predict_instances(he_x, show_tile_progress=False)
    he_ref = {
        "image": {"url": SOURCE_NEW + "example/tcia-he-nuclei-2d.png"},
        "shape": list(he_img.shape),
        "normalization": {"pmin": PMIN, "pmax": PMAX, "low": float(np.float32(he_mi)), "high": float(np.float32(he_ma))},
        "thresholds": {"prob": float(he_model.thresholds.prob), "nms": float(he_model.thresholds.nms)},
        "count": int(he_labels.max()),
        "labels_sha256": label_hash(he_labels),
        "nuclei": nucleus_table_2d(he_labels, he_img),
    }

    # 2D_paper_dsb2018 on test_image_nuclei_2d
    paper_labels, _ = paper.predict_instances(x, show_tile_progress=False)
    paper_score = matching(truth, paper_labels, thresh=0.5)
    paper_ref = {
        "thresholds": {"prob": float(paper.thresholds.prob), "nms": float(paper.thresholds.nms)},
        "count": int(paper_labels.max()),
        "labels_sha256": label_hash(paper_labels),
        "vs_ground_truth": {"f1": float(paper_score.f1), "precision": float(paper_score.precision), "recall": float(paper_score.recall), "n_true": int(paper_score.n_true)},
    }

    # 3D_demo on test_image_nuclei_3d
    img3d, mask3d = test_image_nuclei_3d(return_mask=True)
    img3d_path = Path(abspath("images/img3d.tif"))
    mask3d_path = Path(abspath("images/mask3d.tif"))
    x3d = normalize(img3d, PMIN, PMAX, axis=(0, 1, 2))
    mi3, ma3 = np.percentile(img3d, PMIN), np.percentile(img3d, PMAX)
    rays = rays_from_json(demo3d.config.rays_json)
    prob3, dist3, pts3 = demo3d.predict_sparse(x3d)
    _, _, _, kept3 = non_maximum_suppression_3d_sparse(dist3, prob3, pts3, rays, nms_thresh=demo3d.thresholds.nms)
    ex3d = {}
    res3d = {}
    for n_tiles in ((1, 1, 1), (1, 2, 2)):
        labels3, _ = demo3d.predict_instances(x3d, n_tiles=n_tiles, show_tile_progress=False)
        key = "x".join(str(t) for t in n_tiles)
        res3d[key] = labels3
        sc3 = matching(mask3d, labels3, thresh=0.5)
        ex3d[key] = {
            "n_tiles": list(n_tiles),
            "count": int(labels3.max()),
            "labels_sha256": label_hash(labels3),
            "vs_ground_truth": {"f1": float(sc3.f1), "precision": float(sc3.precision), "recall": float(sc3.recall), "n_true": int(sc3.n_true)},
        }
        if n_tiles == (1, 1, 1):
            ex3d[key]["nuclei"] = nucleus_table_3d(labels3, img3d)
    demo3d_ref = {
        "image": {"url": SOURCE_NEW + "example/stardist-demo-nuclei-3d.tif", "sha256": hashlib.sha256(img3d_path.read_bytes()).hexdigest()},
        "mask": {"url": SOURCE_NEW + "validation/stardist-demo-nuclei-3d-mask.tif", "sha256": hashlib.sha256(mask3d_path.read_bytes()).hexdigest()},
        "shape": list(img3d.shape),
        "normalization": {"pmin": PMIN, "pmax": PMAX, "low": float(np.float32(mi3)), "high": float(np.float32(ma3))},
        "thresholds": {"prob": float(demo3d.thresholds.prob), "nms": float(demo3d.thresholds.nms)},
        "padding": padding_3d_cases([int(v) for v in demo3d._axes_div_by("ZYX")]),
        "nms": {
            "count": int(len(prob3)),
            "prob": f32(prob3),
            "dist": f32(dist3),
            "points": i32(pts3),
            "kept": [int(i) for i in kept3],
            "labels_sha256": ex3d["1x1x1"]["labels_sha256"],
        },
        "example": ex3d,
    }

    reference = {
        "image": {"url": SOURCE_2D + "example/dsb2018-nuclei-2d.tif", "sha256": hashlib.sha256(image_path.read_bytes()).hexdigest()},
        "mask": {"url": SOURCE_2D + "validation/dsb2018-nuclei-2d-mask.tif", "sha256": hashlib.sha256(mask_path.read_bytes()).hexdigest()},
        "shape": list(image.shape),
        "normalization": {"pmin": PMIN, "pmax": PMAX, "low": float(np.float32(mi)), "high": float(np.float32(ma))},
        "thresholds": {"prob": float(fluo.thresholds.prob), "nms": float(fluo.thresholds.nms)},
        "percentiles": percentiles,
        "tiling": tiling_cases(fluo),
        "nms": nms,
        "padding": padding_cases(),
        "padded_crop": padded_crop_case(fluo, image),
        "example": example,
        "he": he_ref,
        "paper_dsb2018": paper_ref,
        "demo_3d": demo3d_ref,
    }
    Path(out_path).write_text(json.dumps(reference, indent=1) + "\n")
    print("2D_versatile_fluo:", {k: {kk: v[kk] for kk in ("count", "labels_sha256")} for k, v in example.items()})
    print("2D_versatile_he:", {"count": he_ref["count"], "labels_sha256": he_ref["labels_sha256"]})
    print("2D_paper_dsb2018:", {"count": paper_ref["count"], "labels_sha256": paper_ref["labels_sha256"], "f1": paper_ref["vs_ground_truth"]["f1"]})
    print("3D_demo:", {k: {kk: v[kk] for kk in ("count", "labels_sha256")} for k, v in ex3d.items()})
    for path in browser:
        labels = tifffile.imread(path)
        for key, want in results.items():
            if want.shape != labels.shape:
                continue
            score = matching(want, labels, thresh=0.5)
            same = np.array_equal(want, labels)
            print(path, key, {"f1": score.f1, "n_true": score.n_true, "n_pred": score.n_pred, "mean_matched_iou": score.mean_matched_score, "identical": bool(same)})


if __name__ == "__main__":
    main(*sys.argv[1:])
