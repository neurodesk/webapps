"""Record Python Cellpose 3.1.1.1 reference outputs on the CC0 Allen Institute examples.

Run in the environment from export_model.py (with scikit-image, tifffile, pooch):

    python reference.py <examples-dir> <out.json>

<examples-dir> holds allen-cells-2d.ome.tif and allen-cells-3d.ome.tif.
Writes reference.json, which the unit tests and browser tests compare against.
"""

import base64
import hashlib
import json
import sys
import zlib
from pathlib import Path

import numpy as np
import tifffile
from cellpose import dynamics, models, transforms, utils
from cellpose.transforms import get_pad_yx
from skimage.measure import regionprops

HF_BASE = "https://huggingface.co/datasets/neurodeskorg/webapps/resolve/bc1de48f8c0857d30f2330e986eef29ec77603b3/cellpose/"


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def label_hash(labels: np.ndarray) -> str:
    return hashlib.sha256(np.ascontiguousarray(labels, "<u4").tobytes()).hexdigest()


def f32_b64(arr: np.ndarray) -> str:
    return base64.b64encode(zlib.compress(np.ascontiguousarray(arr, "<f4").tobytes(), level=9)).decode()


def u32_b64(arr: np.ndarray) -> str:
    return base64.b64encode(zlib.compress(np.ascontiguousarray(arr, "<u4").tobytes(), level=9)).decode()


def measure_2d(masks: np.ndarray, intensity: np.ndarray):
    rows = []
    for r in regionprops(masks, intensity_image=intensity.astype(np.float64)):
        cy, cx = r.centroid
        rows.append([int(r.label), float(cx), float(cy), int(r.area), float(r.intensity_mean)])
    return rows


def measure_3d(masks: np.ndarray, intensity: np.ndarray):
    rows = []
    for r in regionprops(masks, intensity_image=intensity.astype(np.float64)):
        cz, cy, cx = r.centroid
        rows.append([int(r.label), float(cx), float(cy), float(cz), int(r.area), float(r.intensity_mean)])
    return rows


def run_2d_case(model_type: str, img_cyx: np.ndarray, channels: list[int], diameter: float):
    model = models.CellposeModel(gpu=False, model_type=model_type)
    masks, flows, styles = model.eval(
        img_cyx,
        channel_axis=0,
        channels=channels,
        diameter=diameter,
        flow_threshold=0.4,
        cellprob_threshold=0.0,
        min_size=15,
        normalize=True,
        augment=False,
        tile_overlap=0.1,
        bsize=224,
        resample=True,
    )
    primary = img_cyx[channels[0] - 1]
    return {
        "model": model_type,
        "channels": channels,
        "diameter": diameter,
        "flow_threshold": 0.4,
        "cellprob_threshold": 0.0,
        "min_size": 15,
        "shape": list(masks.shape),
        "count": int(masks.max()),
        "nonzero_pixels": int((masks > 0).sum()),
        "labels_sha256": label_hash(masks),
        "labels_u32_zlib_b64": u32_b64(masks),
        "cells": measure_2d(masks, primary),
    }, masks, flows


def run_3d_case(model_type: str, vol_zcyx: np.ndarray, channels: list[int], diameter: float, anisotropy: float):
    model = models.CellposeModel(gpu=False, model_type=model_type)
    masks, flows, styles = model.eval(
        vol_zcyx,
        z_axis=0,
        channel_axis=1,
        channels=channels,
        diameter=diameter,
        do_3D=True,
        anisotropy=anisotropy,
        flow_threshold=0.4,
        cellprob_threshold=0.0,
        min_size=15,
        normalize=True,
        augment=False,
        tile_overlap=0.1,
        bsize=224,
        resample=True,
    )
    primary = vol_zcyx[:, channels[0] - 1]
    return {
        "model": model_type,
        "channels": channels,
        "diameter": diameter,
        "do_3D": True,
        "anisotropy": anisotropy,
        "flow_threshold": 0.4,
        "cellprob_threshold": 0.0,
        "min_size": 15,
        "shape": list(masks.shape),
        "count": int(masks.max()),
        "nonzero_voxels": int((masks > 0).sum()),
        "labels_sha256": label_hash(masks),
        "labels_u32_zlib_b64": u32_b64(masks),
        "cells": measure_3d(masks, primary),
    }, masks, flows


def helper_cases(img_2d: np.ndarray, flows_2d):
    ch0 = img_2d[0].astype(np.float32)
    normed = transforms.normalize99(ch0, lower=1, upper=99)
    taper_16 = transforms._taper_mask(ly=16, lx=16, sig=4.0)
    pad_cases = []
    for ly, lx in ((64, 64), (100, 130), (128, 256), (17, 33)):
        ypad1, ypad2, xpad1, xpad2 = get_pad_yx(ly, lx, div=16)
        pad_cases.append({"ly": ly, "lx": lx, "pad": [int(ypad1), int(ypad2), int(xpad1), int(xpad2)]})

    # Extract a 128x128 crop of dP and cellprob from flows_2d to test follow_flows + get_masks + remove_bad_flow_masks
    dP = flows_2d[1][:, :128, :128].astype(np.float32)
    cellprob = flows_2d[2][:128, :128].astype(np.float32)
    crop_masks = dynamics.compute_masks(
        dP,
        cellprob,
        niter=400,
        cellprob_threshold=0.0,
        flow_threshold=0.4,
        interp=True,
        do_3D=False,
        min_size=15,
    )
    return {
        "normalize99": {
            "shape": list(ch0.shape),
            "sha256": hashlib.sha256(np.ascontiguousarray(normed, "<f4").tobytes()).hexdigest(),
            "min": float(normed.min()),
            "max": float(normed.max()),
            "mean": float(normed.mean()),
        },
        "taper_mask_16": {
            "ly": 16,
            "lx": 16,
            "sig": 4.0,
            "values_f32_zlib_b64": f32_b64(taper_16),
        },
        "pad_yx": pad_cases,
        "compute_masks_crop": {
            "shape": [128, 128],
            "niter": 400,
            "dP_f32_zlib_b64": f32_b64(dP),
            "cellprob_f32_zlib_b64": f32_b64(cellprob),
            "count": int(crop_masks.max()),
            "labels_sha256": label_hash(crop_masks),
            "labels_u32_zlib_b64": u32_b64(crop_masks),
        },
    }


def main():
    if len(sys.argv) != 3:
        raise SystemExit(f"Usage: {sys.argv[0]} <examples-dir> <out.json>")
    ex_dir = Path(sys.argv[1])
    out_path = Path(sys.argv[2])

    p2d = ex_dir / "allen-cells-2d.ome.tif"
    p3d = ex_dir / "allen-cells-3d.ome.tif"
    img_2d = tifffile.imread(p2d)
    vol_3d = tifffile.imread(p3d)
    assert img_2d.shape == (2, 256, 256), f"Unexpected 2D shape {img_2d.shape}"
    assert vol_3d.shape == (10, 2, 64, 64), f"Unexpected 3D shape {vol_3d.shape}"

    print("Running cyto3 2D...", flush=True)
    cyto3_2d, _, flows_cyto3 = run_2d_case("cyto3", img_2d, [1, 2], 60.0)
    print(f"  cyto3 2D: {cyto3_2d['count']} cells", flush=True)

    print("Running nuclei 2D...", flush=True)
    nuclei_2d, _, _ = run_2d_case("nuclei", img_2d, [2, 0], 40.0)
    print(f"  nuclei 2D: {nuclei_2d['count']} nuclei", flush=True)

    print("Running cyto3 3D...", flush=True)
    cyto3_3d, _, _ = run_3d_case("cyto3", vol_3d, [1, 2], 30.0, 1.0)
    print(f"  cyto3 3D: {cyto3_3d['count']} cells", flush=True)

    reference = {
        "generated_by": "apps/cellpose/validation/reference.py",
        "cellpose_version": "3.1.1.1",
        "examples": {
            "allen-cells-2d": {
                "filename": p2d.name,
                "url": HF_BASE + "example/" + p2d.name,
                "sha256": sha256_file(p2d),
                "bytes": p2d.stat().st_size,
                "shape": list(img_2d.shape),
                "axes": "CYX",
            },
            "allen-cells-3d": {
                "filename": p3d.name,
                "url": HF_BASE + "example/" + p3d.name,
                "sha256": sha256_file(p3d),
                "bytes": p3d.stat().st_size,
                "shape": list(vol_3d.shape),
                "axes": "ZCYX",
            },
        },
        "helpers": helper_cases(img_2d, flows_cyto3),
        "cases": {
            "cyto3_2d": cyto3_2d,
            "nuclei_2d": nuclei_2d,
            "cyto3_3d": cyto3_3d,
        },
    }

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(reference, indent=2) + "\n")
    print(f"Wrote {out_path} ({out_path.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
