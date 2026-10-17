#!/usr/bin/env python3
"""Run the SEALS (DeepISLES nnU-Net) fold-0 ONNX export on DWI/TRACE + ADC.

This is the reference the browser port must reproduce. It follows SEALS'
inference exactly, without nnU-Net installed:

1. DWI/TRACE resampled to 1 mm (linear); ADC resampled directly onto that grid
   (linear), as DeepISLES' Task500 conversion does.
2. nnU-Net v1 preprocessing: crop to the hole-filled nonzero mask of both
   channels; per-channel z-score inside that mask, zero outside.
3. nnU-Net v1 sliding window: 128^3 patches, step 0.5, Gaussian importance
   (sigma = patch/8), softmax averaged over the 8 axis mirrorings.
4. Argmax, uncropped onto the 1 mm grid, then nearest-neighbour onto the
   DWI/TRACE native grid.

SEALS was trained on skull-stripped ISLES'22 images. Pass --brain-mask (a
mask on the DWI/TRACE grid) to strip unstripped data first; without it the
inputs are used as given, as DeepISLES does for NIfTI input.

Benchmark use (writes where benchmark_lesion_models.py's
'deepisles-seals-fold0-fp16-onnx' mode reads):

  python3 scripts/run_seals_onnx.py --model lnm-deepisles-seals-fold0-128-fp16.onnx \\
      --soop-raw-root /path/to/soop --subjects paired \\
      --out-root .tmp_weights/deepisles_onnx_run

Single case:

  python3 scripts/run_seals_onnx.py --model ... --dwi trace.nii.gz --adc adc.nii.gz --out pred.nii.gz
"""
from __future__ import annotations

import argparse
import time
from pathlib import Path

import numpy as np
import SimpleITK as sitk
from scipy.ndimage import binary_fill_holes, gaussian_filter

PATCH = (128, 128, 128)
MIRRORS = [(), (2,), (1,), (0,), (2, 1), (2, 0), (1, 0), (2, 1, 0)]
PREDICTION_PATTERN = "{subject}_seals_onnx/{subject}_deepisles-seals-fold0-fp16_onnx_pred.nii.gz"


def respace_1mm(image: sitk.Image) -> sitk.Image:
    size = [int(round(n * s)) for n, s in zip(image.GetSize(), image.GetSpacing())]
    return sitk.Resample(image, size, sitk.Transform(), sitk.sitkLinear, image.GetOrigin(), (1.0, 1.0, 1.0),
                         image.GetDirection(), 0, image.GetPixelID())


def onto(image: sitk.Image, reference: sitk.Image, interpolator=sitk.sitkLinear) -> sitk.Image:
    return sitk.Resample(image, reference, sitk.Transform(), interpolator, 0, image.GetPixelID())


def crop_and_normalize(channels: np.ndarray) -> tuple[np.ndarray, tuple[slice, ...]]:
    nonzero = binary_fill_holes(np.any(channels != 0, axis=0))
    idx = np.nonzero(nonzero)
    bbox = tuple(slice(int(i.min()), int(i.max()) + 1) for i in idx)
    data = channels[(slice(None),) + bbox].astype(np.float32)
    mask = nonzero[bbox]
    for c in range(data.shape[0]):
        values = data[c][mask]
        data[c][mask] = (values - values.mean()) / (values.std() + 1e-8)
        data[c][~mask] = 0
    return data, bbox


def steps(size: int, patch: int, step: float = 0.5) -> list[int]:
    n = int(np.ceil((size - patch) / (patch * step))) + 1
    if n == 1:
        return [0]
    stride = (size - patch) / (n - 1)
    return [int(np.round(stride * i)) for i in range(n)]


def gaussian_importance() -> np.ndarray:
    g = np.zeros(PATCH, np.float32)
    g[tuple(p // 2 for p in PATCH)] = 1
    g = gaussian_filter(g, [p / 8 for p in PATCH], 0, mode="constant", cval=0)
    g = g / g.max()
    g[g == 0] = g[g != 0].min()
    return g.astype(np.float32)


def predict(session, data: np.ndarray, mirror: bool = True) -> np.ndarray:
    pad = [max(0, p - s) for p, s in zip(PATCH, data.shape[1:])]
    before = [p // 2 for p in pad]
    padded = np.pad(data, [(0, 0)] + [(b, p - b) for b, p in zip(before, pad)])
    shape = padded.shape[1:]
    weights = gaussian_importance()
    total = np.zeros((2,) + shape, np.float32)
    count = np.zeros(shape, np.float32)
    flips = MIRRORS if mirror else [()]
    for x in steps(shape[0], PATCH[0]):
        for y in steps(shape[1], PATCH[1]):
            for z in steps(shape[2], PATCH[2]):
                window = (slice(x, x + PATCH[0]), slice(y, y + PATCH[1]), slice(z, z + PATCH[2]))
                patch = padded[(None, slice(None)) + window]
                prob = np.zeros((2,) + PATCH, np.float32)
                for flip in flips:
                    axes = tuple(a + 2 for a in flip)
                    inp = np.ascontiguousarray(np.flip(patch, axes)) if flip else patch
                    logits = session.run(None, {"input": inp})[0]
                    e = np.exp(logits - logits.max(1, keepdims=True))
                    p = e / e.sum(1, keepdims=True)
                    prob += (np.flip(p, axes) if flip else p)[0] / len(flips)
                total[(slice(None),) + window] += prob * weights
                count[window] += weights
    probability = total / count
    crop = tuple(slice(b, b + s) for b, s in zip(before, data.shape[1:]))
    return probability[(slice(None),) + crop]


def segment(session, dwi_path: Path, adc_path: Path, brain_mask_path: Path | None = None, mirror: bool = True) -> sitk.Image:
    dwi = sitk.ReadImage(str(dwi_path), sitk.sitkFloat32)
    adc = sitk.ReadImage(str(adc_path), sitk.sitkFloat32)
    if brain_mask_path is not None:
        # Mask each image on its own grid, as skull-stripped inputs are.
        brain = sitk.ReadImage(str(brain_mask_path), sitk.sitkFloat32)
        dwi = sitk.Mask(dwi, onto(brain, dwi, sitk.sitkNearestNeighbor) > 0)
        adc = sitk.Mask(adc, onto(brain, adc, sitk.sitkNearestNeighbor) > 0)
    dwi_1mm = respace_1mm(dwi)
    adc_1mm = onto(adc, dwi_1mm)
    channels = np.stack([sitk.GetArrayFromImage(dwi_1mm), sitk.GetArrayFromImage(adc_1mm)])
    data, bbox = crop_and_normalize(channels)
    probability = predict(session, data, mirror)
    labels = np.zeros(channels.shape[1:], np.uint8)
    labels[bbox] = (probability[1] > probability[0]).astype(np.uint8)
    seg_1mm = sitk.GetImageFromArray(labels)
    seg_1mm.CopyInformation(dwi_1mm)
    return onto(seg_1mm, dwi, sitk.sitkNearestNeighbor)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--dwi", type=Path)
    parser.add_argument("--adc", type=Path)
    parser.add_argument("--brain-mask", type=Path)
    parser.add_argument("--out", type=Path)
    parser.add_argument("--soop-raw-root", type=Path)
    parser.add_argument("--subjects", default="paired", help="Comma list of SOOP subjects, or paired/prediction-only/soop.")
    parser.add_argument("--out-root", type=Path)
    parser.add_argument("--no-mirror", action="store_true", help="Skip the 8 mirrorings (8x faster, not SEALS' setting).")
    parser.add_argument("--threads", type=int, default=0)
    args = parser.parse_args()

    import onnxruntime as ort
    options = ort.SessionOptions()
    if args.threads:
        options.intra_op_num_threads = args.threads
    session = ort.InferenceSession(str(args.model), options, providers=["CPUExecutionProvider"])

    if args.dwi:
        t0 = time.time()
        sitk.WriteImage(segment(session, args.dwi, args.adc, args.brain_mask, not args.no_mirror), str(args.out))
        print(f"{args.out} ({time.time() - t0:.0f} s)")
        return

    from benchmark_lesion_models import expand_subjects, soop_image_path
    for subject in expand_subjects([s.strip() for s in args.subjects.split(",") if s.strip()]):
        if not subject.startswith("sub-"):
            continue
        out = args.out_root / PREDICTION_PATTERN.format(subject=subject)
        if out.exists():
            print(f"{subject}: exists, skipped")
            continue
        out.parent.mkdir(parents=True, exist_ok=True)
        t0 = time.time()
        seg = segment(session, soop_image_path(args.soop_raw_root, subject, "TRACE"),
                      soop_image_path(args.soop_raw_root, subject, "ADC"), None, not args.no_mirror)
        sitk.WriteImage(seg, str(out))
        print(f"{subject}: {out} ({time.time() - t0:.0f} s)", flush=True)


if __name__ == "__main__":
    main()
