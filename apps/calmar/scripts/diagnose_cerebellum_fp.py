#!/usr/bin/env python3
"""Diagnose the cerebellum false-positive on a specific T1.

Goal: separate "is it the upstream model" from "is it our ONNX conversion".

Strategy: replicate the CALMaR browser lesion-seg pipeline EXACTLY
(web/js/inference-pipeline.js + manifest lnm-stroke-lesion params) and run two
backends on byte-identical patches:

  * onnx-app   : production web/models/_dev_cache/lnm-stroke-lesion.onnx,
                 patch 128, overlap 0.25, no TTA  (== what the user sees)
  * torch-app  : upstream liamchalcroft/synthstroke-baseline safetensors,
                 SAME patch 128, overlap 0.25, no TTA  (isolates conversion)

  * torch-upstream : upstream weights at the model card's recommended config
                     (patch 192, overlap 0.5, TTA on) — does the FP survive the
                     model's intended settings, or is it a 128-patch artifact?

Outputs prob maps + binary masks as NIfTI (input affine) for visual confirm,
plus voxelwise diff stats between onnx-app and torch-app.
"""
import json
import os
import sys
import math
import time

import numpy as np
import nibabel as nib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ONNX_PATH = os.path.join(ROOT, "web/models/_dev_cache/lnm-stroke-lesion.onnx")
OUT_DIR = os.path.join(ROOT, ".tmp_weights", "cerebellum_fp")
INPUT = sys.argv[1] if len(sys.argv) > 1 else \
    "/Users/uqsbollm/Downloads/sub-M2121_ses-258_acq-tfl3p2_run-3_T1w.nii.gz"

THRESHOLD = 0.4
MIN_CC = 30


# --- pipeline helpers (mirror web/js/inference-pipeline.js) ---

def zscore(data):
    data = np.asarray(data, dtype=np.float32)
    mean = float(data.mean())
    std = float(data.std()) or 1.0
    return ((data - mean) / std).astype(np.float32)


def pad_to_multiple(data, patch):
    def pad(d, p):
        if d > p and d % p != 0:
            return math.ceil(d / p) * p
        return p if d < p else d
    sx, sy, sz = data.shape
    tx, ty, tz = pad(sx, patch[0]), pad(sy, patch[1]), pad(sz, patch[2])
    if (tx, ty, tz) == (sx, sy, sz):
        return data, (sx, sy, sz)
    out = np.zeros((tx, ty, tz), dtype=np.float32)
    out[:sx, :sy, :sz] = data
    return out, (sx, sy, sz)


def patch_positions(dims, patch, overlap):
    steps = [max(1, round(p * (1 - overlap))) for p in patch]
    counts = [1 if vd <= patch[i] else max(1, math.ceil((vd - patch[i]) / steps[i]) + 1)
              for i, vd in enumerate(dims)]
    positions, seen = [], set()
    for iz in range(counts[2]):
        z = iz * steps[2]
        if z + patch[2] > dims[2]:
            z = max(0, dims[2] - patch[2])
        for iy in range(counts[1]):
            y = iy * steps[1]
            if y + patch[1] > dims[1]:
                y = max(0, dims[1] - patch[1])
            for ix in range(counts[0]):
                x = ix * steps[0]
                if x + patch[0] > dims[0]:
                    x = max(0, dims[0] - patch[0])
                key = (x, y, z)
                if key not in seen:
                    seen.add(key)
                    positions.append(key)
    return positions


def gaussian_weights(patch, sigma=8.0):
    c = [(d - 1) / 2.0 for d in patch]
    ax = [np.arange(d, dtype=np.float32) - c[i] for i, d in enumerate(patch)]
    xx, yy, zz = np.meshgrid(*ax, indexing="ij")
    return np.exp(-(xx * xx + yy * yy + zz * zz) / (2 * sigma * sigma)).astype(np.float32)


def remove_small_cc(mask, min_size):
    from scipy import ndimage
    binary = mask.astype(bool)
    if min_size <= 1 or not binary.any():
        return binary.astype(np.uint8)
    labels, num = ndimage.label(binary, structure=np.ones((3, 3, 3)))
    if num == 0:
        return binary.astype(np.uint8)
    sizes = np.bincount(labels.ravel())
    keep = sizes >= min_size
    keep[0] = False
    return keep[labels].astype(np.uint8)


def run_pipeline(volume, run_patch, patch, overlap, tta, sigma=8.0, label=""):
    """Returns probability map at the ORIGINAL (pre-pad) shape."""
    norm = zscore(volume)
    padded, orig_shape = pad_to_multiple(norm, patch)
    dims = padded.shape
    weights = gaussian_weights(patch, sigma)
    positions = patch_positions(dims, patch, overlap)
    prob_accum = np.zeros(dims, dtype=np.float32)
    weight_accum = np.zeros(dims, dtype=np.float32)
    tta_axes = [(), (0,), (1,), (2,), (0, 1), (0, 2), (1, 2), (0, 1, 2)] if tta else [()]
    t0 = time.time()
    for pi, (x, y, z) in enumerate(positions):
        patch_data = padded[x:x + patch[0], y:y + patch[1], z:z + patch[2]]
        prob_sum = np.zeros(patch, dtype=np.float32)
        for axes in tta_axes:
            pin = np.flip(patch_data, axis=axes).copy() if axes else patch_data
            pred = run_patch(pin)  # stroke probability, shape == patch
            if axes:
                pred = np.flip(pred, axis=axes).copy()
            prob_sum += pred.astype(np.float32)
        prob = prob_sum / float(len(tta_axes))
        prob_accum[x:x + patch[0], y:y + patch[1], z:z + patch[2]] += prob * weights
        weight_accum[x:x + patch[0], y:y + patch[1], z:z + patch[2]] += weights
        print(f"  [{label}] patch {pi + 1}/{len(positions)} pos={x,y,z} "
              f"p[min/max]={prob.min():.3f}/{prob.max():.3f}  ({time.time()-t0:.0f}s)", flush=True)
    weight_accum[weight_accum == 0] = 1.0
    merged = prob_accum / weight_accum
    sx, sy, sz = orig_shape
    return merged[:sx, :sy, :sz].astype(np.float32)


# --- backends ---

def onnx_runner():
    import onnxruntime as ort
    sess = ort.InferenceSession(ONNX_PATH, providers=["CPUExecutionProvider"])
    iname = sess.get_inputs()[0].name
    oname = sess.get_outputs()[0].name

    def run_patch(patch):
        tensor = patch[None, None].astype(np.float32)
        logits = sess.run([oname], {iname: tensor})[0][0]  # (2, x, y, z)
        # softmax stroke channel == sigmoid(l_stroke - l_bg), matches worker
        return _softmax_stroke(logits)
    return run_patch


def torch_runner(device_str="auto"):
    import torch
    from huggingface_hub import hf_hub_download
    from monai.networks.nets import UNet
    from safetensors.torch import load_file

    if device_str == "auto":
        device = torch.device("mps") if torch.backends.mps.is_available() else torch.device("cpu")
    else:
        device = torch.device(device_str)
    cfg = json.load(open(hf_hub_download("liamchalcroft/synthstroke-baseline", "config.json")))
    weights = load_file(hf_hub_download("liamchalcroft/synthstroke-baseline", "model.safetensors"))
    model = UNet(
        spatial_dims=cfg["spatial_dims"], in_channels=cfg["in_channels"],
        out_channels=cfg["out_channels"], channels=tuple(cfg["channels"]),
        strides=tuple(cfg["strides"]), kernel_size=cfg["kernel_size"],
        up_kernel_size=cfg["up_kernel_size"], num_res_units=cfg["num_res_units"],
        act=cfg["act"], norm=cfg["norm"], dropout=cfg["dropout"],
        bias=cfg["bias"], adn_ordering=cfg["adn_ordering"],
    )
    missing, unexpected = model.load_state_dict(weights, strict=False)
    print(f"torch load: missing={len(missing)} unexpected={len(unexpected)} device={device}")
    model.to(device).eval()

    def run_patch(patch):
        with torch.no_grad():
            t = torch.from_numpy(patch[None, None].astype(np.float32)).to(device)
            logits = model(t).detach().cpu().numpy()[0]  # (2, x, y, z)
        return _softmax_stroke(logits)
    return run_patch, str(device)


def _softmax_stroke(logits):
    m = np.max(logits, axis=0, keepdims=True)
    e = np.exp(logits - m)
    return (e[1] / np.maximum(e.sum(axis=0), 1e-12)).astype(np.float32)


def save(arr, affine, header, path):
    nib.save(nib.Nifti1Image(arr, affine, header=header), path)
    print(f"  wrote {path}")


def stats(name, prob, thr=THRESHOLD):
    binm = remove_small_cc(prob >= thr, MIN_CC)
    print(f"[{name}] prob max={prob.max():.4f} | voxels>={thr}: {int((prob>=thr).sum())} "
          f"| after CC>={MIN_CC}: {int(binm.sum())}")
    return binm


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    img = nib.as_closest_canonical(nib.load(INPUT))
    vol = np.asanyarray(img.dataobj).astype(np.float32)
    if vol.ndim == 4:
        vol = vol[..., 0]
    print(f"input {INPUT}\n  shape={vol.shape} canonical RAS, threshold={THRESHOLD}, minCC={MIN_CC}\n")

    P128, P192 = (128, 128, 128), (192, 192, 192)

    # 1) ONNX, app config
    print("=== ONNX (production .onnx), app config 128/0.25/noTTA ===")
    onnx_prob = run_pipeline(vol, onnx_runner(), P128, 0.25, False, label="onnx-app")
    onnx_bin = stats("onnx-app", onnx_prob)
    save(onnx_prob, img.affine, img.header, os.path.join(OUT_DIR, "prob_onnx_app.nii.gz"))
    save(onnx_bin.astype(np.uint8), img.affine, img.header, os.path.join(OUT_DIR, "mask_onnx_app.nii.gz"))

    # 2) Torch upstream weights, SAME app config -> isolates conversion
    print("\n=== TORCH (upstream weights), SAME app config 128/0.25/noTTA ===")
    trun, dev = torch_runner()
    torch_prob = run_pipeline(vol, trun, P128, 0.25, False, label="torch-app")
    torch_bin = stats("torch-app", torch_prob)
    save(torch_prob, img.affine, img.header, os.path.join(OUT_DIR, "prob_torch_app.nii.gz"))
    save(torch_bin.astype(np.uint8), img.affine, img.header, os.path.join(OUT_DIR, "mask_torch_app.nii.gz"))

    # Conversion fidelity: onnx-app vs torch-app on identical patches
    diff = np.abs(onnx_prob - torch_prob)
    inter = int((onnx_bin & torch_bin).sum())
    union = int((onnx_bin | torch_bin).sum())
    dice = (2 * inter / (int(onnx_bin.sum()) + int(torch_bin.sum()))) if (onnx_bin.sum()+torch_bin.sum()) else 1.0
    print("\n--- CONVERSION FIDELITY (onnx-app vs torch-app, same config) ---")
    print(f"  prob abs diff: max={diff.max():.5f} mean={diff.mean():.3e} "
          f"p99={np.percentile(diff,99):.5f}")
    print(f"  binary mask Dice={dice:.4f}  IoU={(inter/union if union else 1):.4f}  "
          f"(onnx={int(onnx_bin.sum())} vox, torch={int(torch_bin.sum())} vox)")

    # 3) Torch upstream RECOMMENDED config: 192/0.5/TTA
    print("\n=== TORCH (upstream weights), upstream config 192/0.5/TTA-on ===")
    up_prob = run_pipeline(vol, trun, P192, 0.5, True, label="torch-upstream")
    up_bin = stats("torch-upstream", up_prob)
    save(up_prob, img.affine, img.header, os.path.join(OUT_DIR, "prob_torch_upstream.nii.gz"))
    save(up_bin.astype(np.uint8), img.affine, img.header, os.path.join(OUT_DIR, "mask_torch_upstream.nii.gz"))

    print("\nDONE. NIfTIs in", OUT_DIR)


if __name__ == "__main__":
    main()
