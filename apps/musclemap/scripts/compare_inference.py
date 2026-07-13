#!/usr/bin/env python3
"""
Compare ONNX inference (matching JS pipeline) vs MONAI reference pipeline.

Helps diagnose segmentation quality issues by comparing:
  1. JS-matching preprocessing → ONNX model
  2. MONAI reference preprocessing → ONNX model
  3. MONAI reference preprocessing → PyTorch model (if checkpoint provided)

Usage:
    pip install torch monai nibabel onnxruntime numpy
    python scripts/compare_inference.py --input /path/to/input.nii.gz --model web/models/musclemap-wholebody.onnx
    python scripts/compare_inference.py --input /path/to/input.nii.gz --model web/models/musclemap-wholebody.onnx --checkpoint /path/to/model.pth
"""

import argparse
import os
import sys
import numpy as np
import nibabel as nib

# ==================== JS-matching preprocessing ====================

def orient_to_ras(img):
    """Orient NIfTI image to RAS using nibabel."""
    return nib.as_closest_canonical(img)


def resample_to_target(data, affine, target_spacing=(1.0, 1.0, -1.0)):
    """Resample volume to target spacing (trilinear). -1 = keep original."""
    from scipy.ndimage import zoom
    voxel_size = np.abs(np.diag(affine[:3, :3]))
    actual_target = [
        vs if ts < 0 else ts for vs, ts in zip(voxel_size, target_spacing)
    ]
    zoom_factors = voxel_size / actual_target
    if np.allclose(zoom_factors, 1.0, atol=0.01):
        return data, actual_target
    resampled = zoom(data, zoom_factors, order=1)  # trilinear
    return resampled, actual_target


def zscore_nonzero(data):
    """Z-score normalize nonzero voxels."""
    mask = data != 0
    if not mask.any():
        return data.copy()
    vals = data[mask]
    mean = vals.mean()
    std = vals.std()
    if std == 0:
        std = 1.0
    result = np.zeros_like(data, dtype=np.float32)
    result[mask] = (data[mask] - mean) / std
    return result


def crop_foreground(data, margin=20):
    """Crop to bounding box of nonzero region with margin."""
    nonzero = np.argwhere(data != 0)
    if len(nonzero) == 0:
        return data, (0, 0, 0), data.shape
    mins = nonzero.min(axis=0)
    maxs = nonzero.max(axis=0) + 1
    starts = np.maximum(mins - margin, 0)
    ends = np.minimum(maxs + margin, data.shape)
    cropped = data[starts[0]:ends[0], starts[1]:ends[1], starts[2]:ends[2]]
    return cropped, tuple(starts), tuple(ends)


def js_preprocess(nifti_path):
    """Reproduce the JS inference-worker.js preprocessing pipeline."""
    img = nib.load(nifti_path)
    print(f"  Original: shape={img.shape}, voxel_size={np.abs(np.diag(img.affine[:3,:3])).round(3)}")

    # 1. Orient to RAS
    img_ras = orient_to_ras(img)
    data = img_ras.get_fdata(dtype=np.float32)
    affine = img_ras.affine
    print(f"  After RAS: shape={data.shape}")

    # 2. Resample to 1mm iso XY
    data, spacing = resample_to_target(data, affine)
    print(f"  After resample: shape={data.shape}, spacing={[round(s,3) for s in spacing]}")

    # 3. Z-score nonzero
    data = zscore_nonzero(data)
    nonzero_count = (data != 0).sum()
    print(f"  After z-score: nonzero={nonzero_count}, range=[{data.min():.3f}, {data.max():.3f}]")

    # 4. Crop foreground
    data, crop_start, crop_end = crop_foreground(data, margin=20)
    print(f"  After crop: shape={data.shape}, origin={crop_start}")

    return data, img_ras


def compute_gaussian_weights(h, w):
    """Match JS: sigma = min(h,w)/8, centered 2D Gaussian."""
    sigma = min(h, w) / 8
    cy, cx = (h - 1) / 2, (w - 1) / 2
    y, x = np.mgrid[0:h, 0:w]
    weights = np.exp(-((y - cy)**2 + (x - cx)**2) / (2 * sigma**2))
    return weights.astype(np.float32)


def sliding_window_inference_2d(data, session, num_classes, roi_size, overlap=0.5):
    """Run 2D sliding window inference matching JS pipeline."""
    nx, ny, nz = data.shape
    label_volume = np.zeros(data.shape, dtype=np.uint8)
    gaussian = compute_gaussian_weights(roi_size, roi_size)

    input_name = session.get_inputs()[0].name
    step = max(1, round(roi_size * (1 - overlap)))

    for z in range(nz):
        slc = data[:, :, z]  # [nx, ny] = [X, Y]
        if not slc.any():
            continue

        # In NIfTI (Fortran order), data[x, y, z].
        # For the model: need [H, W] = [Y, X] (rows=Y, cols=X)
        slc_hw = slc.T  # [ny, nx] = [H, W]

        h, w = slc_hw.shape
        pad_h = max(h, roi_size)
        pad_w = max(w, roi_size)
        padded = np.zeros((pad_h, pad_w), dtype=np.float32)
        off_y = (pad_h - h) // 2
        off_x = (pad_w - w) // 2
        padded[off_y:off_y+h, off_x:off_x+w] = slc_hw

        # Compute tile positions
        positions_h = set()
        for pos in range(0, pad_h - roi_size + 1, step):
            positions_h.add(pos)
        positions_h.add(max(0, pad_h - roi_size))

        positions_w = set()
        for pos in range(0, pad_w - roi_size + 1, step):
            positions_w.add(pos)
        positions_w.add(max(0, pad_w - roi_size))

        accum = np.zeros((pad_h, pad_w, num_classes), dtype=np.float32)
        weight_sum = np.zeros((pad_h, pad_w), dtype=np.float32)

        for ty in sorted(positions_h):
            for tx in sorted(positions_w):
                patch = padded[ty:ty+roi_size, tx:tx+roi_size]
                inp = patch[np.newaxis, np.newaxis, :, :]  # [1, 1, H, W]
                out = session.run(None, {input_name: inp})[0]  # [1, C, H, W]
                out = out[0]  # [C, H, W]

                for c in range(num_classes):
                    accum[ty:ty+roi_size, tx:tx+roi_size, c] += out[c] * gaussian

                weight_sum[ty:ty+roi_size, tx:tx+roi_size] += gaussian

        # Argmax
        mask = weight_sum > 0
        labels_2d = np.zeros((pad_h, pad_w), dtype=np.uint8)
        labels_2d[mask] = accum[mask].argmax(axis=-1).astype(np.uint8)

        # Unpad and transpose back to [X, Y]
        labels_unpad = labels_2d[off_y:off_y+h, off_x:off_x+w]
        label_volume[:, :, z] = labels_unpad.T  # [H,W]=[Y,X] → [X,Y]

        if z % 20 == 0 or z == nz - 1:
            detected = len(np.unique(labels_unpad)) - (1 if 0 in labels_unpad else 0)
            print(f"  Slice {z+1}/{nz}: {detected} labels")

    return label_volume


# ==================== MONAI reference pipeline ====================

def monai_preprocess(nifti_path, target_spacing=(1.0, 1.0, -1.0)):
    """MONAI reference preprocessing (ground truth)."""
    from monai.transforms import (
        LoadImage, EnsureChannelFirst, Orientation, Spacing,
        NormalizeIntensity, CropForeground, Compose
    )

    img = nib.load(nifti_path)
    orig_spacing = np.abs(np.diag(img.affine[:3, :3]))
    actual_target = tuple(
        os if ts < 0 else ts for os, ts in zip(orig_spacing, target_spacing)
    )

    transforms = Compose([
        LoadImage(image_only=True),
        EnsureChannelFirst(),
        Orientation(axcodes="RAS"),
        Spacing(pixdim=actual_target, mode="bilinear"),
        NormalizeIntensity(nonzero=True),
        CropForeground(margin=20),
    ])

    data = transforms(nifti_path)
    print(f"  MONAI preprocessed: shape={data.shape}")
    return data.numpy()


def monai_sliding_window(data_4d, session, num_classes, roi_size, overlap=0.5):
    """MONAI-style 2D sliding window on channel-first [1, X, Y, Z] data."""
    data_3d = data_4d[0]  # [X, Y, Z]
    return sliding_window_inference_2d(data_3d, session, num_classes, roi_size, overlap)


# ==================== Main ====================

def count_labels(vol):
    """Count detected labels and their voxel counts."""
    unique, counts = np.unique(vol, return_counts=True)
    return {int(u): int(c) for u, c in zip(unique, counts) if u > 0}


def save_nifti(data, reference_img, path):
    """Save data as NIfTI using reference image's affine/header."""
    img = nib.Nifti1Image(data.astype(np.uint8), reference_img.affine, reference_img.header)
    img.header.set_data_dtype(np.uint8)
    nib.save(img, path)
    print(f"  Saved: {path}")


def main():
    parser = argparse.ArgumentParser(description="Compare ONNX vs MONAI inference")
    parser.add_argument("--input", required=True, help="Input NIfTI file")
    parser.add_argument("--model", required=True, help="ONNX model path")
    parser.add_argument("--checkpoint", default=None, help="PyTorch .pth checkpoint (optional)")
    parser.add_argument("--num-classes", type=int, default=None, help="Number of output classes (auto-detected from model)")
    parser.add_argument("--roi-size", type=int, default=None, help="ROI size (auto-detected from model)")
    parser.add_argument("--overlap", type=float, default=0.5, help="Sliding window overlap (default: 0.5)")
    parser.add_argument("--output-dir", default=None, help="Output directory (default: same as input)")
    args = parser.parse_args()

    import onnxruntime as ort

    # Load ONNX model
    print(f"\n{'='*60}")
    print("Loading ONNX model...")
    session = ort.InferenceSession(args.model, providers=["CPUExecutionProvider"])
    out_shape = session.get_outputs()[0].shape
    inp_shape = session.get_inputs()[0].shape
    print(f"  Input shape: {inp_shape}, Output shape: {out_shape}")

    # Auto-detect num_classes and roi_size from model
    num_classes = args.num_classes or (out_shape[1] if isinstance(out_shape[1], int) else 100)
    roi_size = args.roi_size or (inp_shape[2] if isinstance(inp_shape[2], int) else 256)
    print(f"  num_classes={num_classes}, roi_size={roi_size}, overlap={args.overlap}")

    output_dir = args.output_dir or os.path.dirname(args.input) or "."
    basename = os.path.splitext(os.path.splitext(os.path.basename(args.input))[0])[0]

    # ==================== Pipeline 1: JS-matching ====================
    print(f"\n{'='*60}")
    print("Pipeline 1: JS-matching preprocessing → ONNX")
    js_data, img_ras = js_preprocess(args.input)

    print("\n  Running sliding window inference...")
    js_result = sliding_window_inference_2d(js_data, session, num_classes, roi_size, args.overlap)

    js_labels = count_labels(js_result)
    print(f"\n  JS pipeline: {len(js_labels)} muscles, {sum(js_labels.values())} total voxels")
    for label_idx, count in sorted(js_labels.items()):
        print(f"    Label {label_idx}: {count} voxels")

    # Save JS result
    js_path = os.path.join(output_dir, f"{basename}_seg_js_onnx.nii.gz")
    save_nifti(js_result, img_ras, js_path)

    # ==================== Pipeline 2: MONAI reference ====================
    try:
        print(f"\n{'='*60}")
        print("Pipeline 2: MONAI preprocessing → ONNX")
        monai_data = monai_preprocess(args.input)

        print("\n  Running sliding window inference...")
        monai_result = monai_sliding_window(monai_data, session, num_classes, roi_size, args.overlap)

        monai_labels = count_labels(monai_result)
        print(f"\n  MONAI pipeline: {len(monai_labels)} muscles, {sum(monai_labels.values())} total voxels")
        for label_idx, count in sorted(monai_labels.items()):
            print(f"    Label {label_idx}: {count} voxels")

        monai_path = os.path.join(output_dir, f"{basename}_seg_monai_onnx.nii.gz")
        # Need to uncrop and inverse resample for fair comparison
        # For now, save in preprocessed space
        print(f"  Note: MONAI result is in preprocessed (cropped) space")

        # Compare the two pipelines
        print(f"\n{'='*60}")
        print("Comparison: JS vs MONAI preprocessing")
        print(f"  JS shape:    {js_data.shape}")
        print(f"  MONAI shape: {monai_data.shape if monai_data.ndim == 3 else monai_data[0].shape}")

        js_total = sum(js_labels.values())
        monai_total = sum(monai_labels.values())
        print(f"  JS total labeled voxels:    {js_total}")
        print(f"  MONAI total labeled voxels: {monai_total}")
        print(f"  JS detected muscles:    {len(js_labels)}")
        print(f"  MONAI detected muscles: {len(monai_labels)}")

        # Check which labels differ
        all_labels = set(js_labels.keys()) | set(monai_labels.keys())
        print(f"\n  Per-label comparison:")
        print(f"  {'Label':>6} {'JS voxels':>12} {'MONAI voxels':>14} {'Diff %':>10}")
        for label in sorted(all_labels):
            js_c = js_labels.get(label, 0)
            monai_c = monai_labels.get(label, 0)
            ref = max(js_c, monai_c, 1)
            diff_pct = (js_c - monai_c) / ref * 100
            print(f"  {label:>6} {js_c:>12} {monai_c:>14} {diff_pct:>+9.1f}%")

    except ImportError:
        print("  MONAI not installed — skipping MONAI pipeline comparison")
        print("  Install with: pip install monai")

    # ==================== Pipeline 3: PyTorch (optional) ====================
    if args.checkpoint:
        try:
            print(f"\n{'='*60}")
            print("Pipeline 3: MONAI preprocessing → PyTorch model")
            import torch
            from monai.networks.nets import UNet

            # Detect model config from ONNX
            config = {
                "spatial_dims": 2,
                "in_channels": 1,
                "out_channels": num_classes,
                "channels": [64, 128, 256, 512, 1024],
                "strides": [2, 2, 2, 2],
                "num_res_units": 1,
                "act": "LeakyReLU",
                "norm": "instance",
            }

            model = UNet(**config)
            checkpoint = torch.load(args.checkpoint, map_location="cpu", weights_only=True)
            if isinstance(checkpoint, dict) and "model_state_dict" in checkpoint:
                state_dict = checkpoint["model_state_dict"]
            elif isinstance(checkpoint, dict) and "state_dict" in checkpoint:
                state_dict = checkpoint["state_dict"]
            else:
                state_dict = checkpoint
            model.load_state_dict(state_dict)
            model.eval()

            # Run single-slice comparison: PyTorch vs ONNX on same input
            print("\n  Single-slice comparison (middle slice):")
            if monai_data is not None:
                test_data = monai_data[0] if monai_data.ndim == 4 else monai_data
                mid_z = test_data.shape[2] // 2
                slc = test_data[:, :, mid_z].T  # [H, W]
                inp = slc[np.newaxis, np.newaxis, :, :]

                # Pad to roi_size if needed
                h, w = slc.shape
                if h < roi_size or w < roi_size:
                    padded = np.zeros((1, 1, max(h, roi_size), max(w, roi_size)), dtype=np.float32)
                    oh, ow = (max(h, roi_size) - h) // 2, (max(w, roi_size) - w) // 2
                    padded[0, 0, oh:oh+h, ow:ow+w] = slc
                    inp = padded

                # ONNX output
                onnx_out = session.run(None, {session.get_inputs()[0].name: inp.astype(np.float32)})[0]
                onnx_argmax = onnx_out[0].argmax(axis=0)

                # PyTorch output
                with torch.no_grad():
                    pt_out = model(torch.from_numpy(inp.astype(np.float32))).numpy()
                pt_argmax = pt_out[0].argmax(axis=0)

                match = (onnx_argmax == pt_argmax).mean() * 100
                print(f"    Slice {mid_z}: argmax match = {match:.2f}%")
                print(f"    ONNX unique labels:    {sorted(np.unique(onnx_argmax))}")
                print(f"    PyTorch unique labels: {sorted(np.unique(pt_argmax))}")

                # Check softmax magnitudes
                onnx_max = onnx_out[0].max(axis=0)
                pt_max = pt_out[0].max(axis=0)
                print(f"    ONNX max logit:    mean={onnx_max.mean():.3f}, std={onnx_max.std():.3f}")
                print(f"    PyTorch max logit: mean={pt_max.mean():.3f}, std={pt_max.std():.3f}")

        except Exception as e:
            print(f"  PyTorch comparison failed: {e}")

    print(f"\n{'='*60}")
    print("Done. Compare the saved NIfTI files in a viewer.")


if __name__ == "__main__":
    main()
