#!/usr/bin/env python3
"""Benchmark SynthStroke-family lesion models on CALMaR fixtures and SOOP.

This is an opt-in research benchmark. It does not change the web app manifest,
runtime model, or UI. Outputs are written under .tmp_weights/ by default.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import os
import time
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterable

import nibabel as nib
import numpy as np
from nibabel.processing import resample_from_to
from scipy import ndimage


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SOOP_RAW_ROOT = Path("/Users/uqsbollm/Downloads/testdata/stroke_data/soop")
DEFAULT_SOOP_MASK_ROOT = Path("/Users/uqsbollm/Downloads/testdata/stroke_data/derivatives/lesion_masks")
DEFAULT_OUT_DIR = ROOT / ".tmp_weights" / "lesion_model_benchmark"
CURRENT_ONNX_CACHE = ROOT / "web/models/_dev_cache/lnm-stroke-lesion.onnx"
CURRENT_ONNX_URL = (
    "https://huggingface.co/datasets/sbollmann/lnm-webapp-models"
    "/resolve/main/models/lnm-stroke-lesion.onnx"
)
CURRENT_ONNX_MIN_BYTES = 10_000_000
DS004884_T1 = ROOT / "tests/fixtures/ds004884-mini/T1.nii.gz"
DS004884_MASK = ROOT / "tests/fixtures/ds004884-mini/lesion_mask.nii.gz"

SOOP_PAIRED_SUBJECTS = [
    "sub-1", "sub-2", "sub-3", "sub-4", "sub-5", "sub-7",
    "sub-8", "sub-9", "sub-10", "sub-11", "sub-13", "sub-14",
]
SOOP_PREDICTION_ONLY_SUBJECTS = ["sub-6", "sub-12"]
SOOP_CONTRASTS = ["T1w", "FLAIR", "ADC", "TRACE"]
DEFAULT_THRESHOLDS = [0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]


@dataclass(frozen=True)
class Case:
    dataset: str
    subject: str
    contrast: str
    image_path: Path
    mask_path: Path | None
    paired: bool


@dataclass(frozen=True)
class ModeSpec:
    id: str
    backend: str
    repo_id: str | None
    patch_size: tuple[int, int, int]
    overlap: float
    tta: bool
    out_channels: int
    stroke_channel: int
    min_component_size: int
    source: str


@dataclass(frozen=True)
class DeepIslesModeSpec:
    id: str
    backend: str
    input_contrasts: tuple[str, str]
    patch_size: tuple[int, int, int]
    overlap: float
    tta: bool
    channel_order: tuple[str, str]
    min_component_size: int
    source: str
    prediction_glob: str | None = None
    probability_globs: tuple[str, ...] = ()
    probability_threshold: float = 0.5


MODE_SPECS = {
    "baseline-app": ModeSpec(
        id="baseline-app",
        backend="onnx",
        repo_id=None,
        patch_size=(128, 128, 128),
        overlap=0.25,
        tta=False,
        out_channels=2,
        stroke_channel=1,
        min_component_size=30,
        source="current CALMaR lnm-stroke-lesion.onnx",
    ),
    "baseline-upstream-like": ModeSpec(
        id="baseline-upstream-like",
        backend="torch",
        repo_id="liamchalcroft/synthstroke-baseline",
        patch_size=(192, 192, 192),
        overlap=0.5,
        tta=True,
        out_channels=2,
        stroke_channel=1,
        min_component_size=30,
        source="liamchalcroft/synthstroke-baseline",
    ),
    "synthplus-app-like": ModeSpec(
        id="synthplus-app-like",
        backend="torch",
        repo_id="liamchalcroft/synthstroke-synth-plus",
        patch_size=(128, 128, 128),
        overlap=0.25,
        tta=False,
        out_channels=6,
        stroke_channel=5,
        min_component_size=30,
        source="liamchalcroft/synthstroke-synth-plus",
    ),
    "synthplus-upstream-like": ModeSpec(
        id="synthplus-upstream-like",
        backend="torch",
        repo_id="liamchalcroft/synthstroke-synth-plus",
        patch_size=(192, 192, 192),
        overlap=0.5,
        tta=True,
        out_channels=6,
        stroke_channel=5,
        min_component_size=30,
        source="liamchalcroft/synthstroke-synth-plus",
    ),
}

DEEPISLES_MODE_SPECS = {
    "deepisles-nvauto-single-fold": DeepIslesModeSpec(
        id="deepisles-nvauto-single-fold",
        backend="deepisles-prediction",
        input_contrasts=("ADC", "TRACE"),
        patch_size=(192, 192, 128),
        overlap=0.625,
        tta=False,
        channel_order=("ADC", "TRACE"),
        min_component_size=30,
        source="DeepISLES NVAUTO single browser-candidate fold (model7 by prior SOOP sub-1 sweep)",
        prediction_glob="{subject}_nvauto_allfolds/{subject}_deepisles-nvauto-model7_onnx_pred.nii.gz",
    ),
    "deepisles-nvauto-best3": DeepIslesModeSpec(
        id="deepisles-nvauto-best3",
        backend="deepisles-probability-mean",
        input_contrasts=("ADC", "TRACE"),
        patch_size=(192, 192, 128),
        overlap=0.625,
        tta=False,
        channel_order=("ADC", "TRACE"),
        min_component_size=30,
        source="DeepISLES NVAUTO best-3 browser-candidate folds (models 7, 9, 11 by prior SOOP sub-1 sweep)",
        probability_globs=(
            "{subject}_nvauto_allfolds/{subject}_deepisles-nvauto-model7_onnx_prob.nii.gz",
            "{subject}_nvauto_allfolds/{subject}_deepisles-nvauto-model9_onnx_prob.nii.gz",
            "{subject}_nvauto_allfolds/{subject}_deepisles-nvauto-model11_onnx_prob.nii.gz",
        ),
        probability_threshold=0.5,
    ),
    "deepisles-nvauto-15fold": DeepIslesModeSpec(
        id="deepisles-nvauto-15fold",
        backend="deepisles-prediction",
        input_contrasts=("ADC", "TRACE"),
        patch_size=(192, 192, 128),
        overlap=0.625,
        tta=False,
        channel_order=("ADC", "TRACE"),
        min_component_size=30,
        source="DeepISLES NVAUTO 15-fold ONNX ensemble",
        prediction_glob="{subject}_nvauto_allfolds/{subject}_deepisles-nvauto-15fold_onnx_pred.nii.gz",
    ),
}

DEFAULT_MODES = list(MODE_SPECS.keys())
ALL_MODE_SPECS = {**MODE_SPECS, **DEEPISLES_MODE_SPECS}

TTA_AXES = [
    (),
    (0,), (1,), (2,),
    (0, 1), (0, 2), (1, 2),
    (0, 1, 2),
]


class BenchmarkError(RuntimeError):
    pass


def parse_csv_list(value: str) -> list[str]:
    return [item.strip() for item in value.split(",") if item.strip()]


def parse_thresholds(value: str) -> list[float]:
    thresholds = [float(item) for item in parse_csv_list(value)]
    if not thresholds:
        raise BenchmarkError("At least one threshold is required.")
    for threshold in thresholds:
        if threshold <= 0 or threshold >= 1:
            raise BenchmarkError(f"Threshold {threshold} must be between 0 and 1.")
    return sorted(set(thresholds))


def soop_image_path(raw_root: Path, subject: str, contrast: str) -> Path:
    if contrast == "T1w":
        return raw_root / subject / "anat" / f"{subject}_T1w.nii.gz"
    if contrast == "FLAIR":
        return raw_root / subject / "anat" / f"{subject}_FLAIR.nii.gz"
    if contrast == "ADC":
        return raw_root / subject / "dwi" / f"{subject}_rec-ADC_dwi.nii.gz"
    if contrast == "TRACE":
        return raw_root / subject / "dwi" / f"{subject}_rec-TRACE_dwi.nii.gz"
    raise BenchmarkError(f"Unknown contrast: {contrast}")


def soop_combined_mask_path(mask_root: Path, subject: str) -> Path:
    return mask_root / subject / "dwi" / f"{subject}_space-TRACE_desc-lesion_mask.nii.gz"


def discover_cases(raw_root: Path, mask_root: Path, subjects: list[str], contrasts: list[str]) -> list[Case]:
    cases: list[Case] = []
    if "ds004884" in subjects:
        require_file(DS004884_T1, "ds004884 T1 fixture")
        require_file(DS004884_MASK, "ds004884 lesion mask fixture")
        cases.append(Case("ds004884", "ds004884-sub-M2051", "T1w", DS004884_T1, DS004884_MASK, True))

    soop_subjects = [subject for subject in subjects if subject.startswith("sub-")]
    if soop_subjects:
        require_dir(raw_root, "SOOP raw root")
        require_dir(mask_root, "SOOP lesion-mask root")
    for subject in soop_subjects:
        paired = subject in SOOP_PAIRED_SUBJECTS
        prediction_only = subject in SOOP_PREDICTION_ONLY_SUBJECTS
        if not paired and not prediction_only:
            raise BenchmarkError(
                f"{subject} is not in the planned SOOP subject set. "
                "Use --subjects explicitly only with planned paired or prediction-only subjects."
            )
        mask_path = soop_combined_mask_path(mask_root, subject)
        if paired:
            require_file(mask_path, f"{subject} combined TRACE-space lesion mask")
        elif mask_path.exists():
            raise BenchmarkError(f"{subject} unexpectedly has a combined mask at {mask_path}")
        for contrast in contrasts:
            image_path = soop_image_path(raw_root, subject, contrast)
            require_file(image_path, f"{subject} {contrast} image")
            cases.append(Case("soop", subject, contrast, image_path, mask_path if paired else None, paired))

    seen_contrasts = {case.contrast for case in cases if case.dataset == "soop"}
    missing = [contrast for contrast in contrasts if soop_subjects and contrast not in seen_contrasts]
    if missing:
        raise BenchmarkError(f"SOOP contrast coverage is incomplete: missing {', '.join(missing)}")
    return cases


def require_file(path: Path, label: str) -> None:
    if not path.exists() or not path.is_file():
        raise BenchmarkError(f"Missing {label}: {path}")


def require_dir(path: Path, label: str) -> None:
    if not path.exists() or not path.is_dir():
        raise BenchmarkError(f"Missing {label}: {path}")


def load_nifti_3d(path: Path, *, binary: bool = False) -> tuple[nib.Nifti1Image, np.ndarray, list[str]]:
    image = nib.load(str(path))
    data = np.asanyarray(image.dataobj)
    notes: list[str] = []
    if data.ndim == 4:
        if data.shape[3] != 1:
            raise BenchmarkError(f"{path} is 4D with shape {data.shape}; only singleton 4D volumes are supported.")
        data = data[..., 0]
        notes.append("squeezed singleton 4D volume")
    if data.ndim != 3:
        raise BenchmarkError(f"{path} is {data.ndim}D after loading; expected 3D.")
    if binary:
        array = (data > 0).astype(np.uint8)
    else:
        array = np.asarray(data, dtype=np.float32)
    squeezed = nib.Nifti1Image(array, image.affine, header=image.header)
    return squeezed, array, notes


def zscore_normalize(data: np.ndarray) -> np.ndarray:
    data = np.asarray(data, dtype=np.float32)
    std = float(data.std())
    if not math.isfinite(std) or std == 0:
        std = 1.0
    return ((data - float(data.mean())) / std).astype(np.float32)


def padded_shape(shape: tuple[int, int, int], patch_size: tuple[int, int, int]) -> tuple[int, int, int]:
    out = []
    for dim, patch in zip(shape, patch_size):
        if dim > patch and dim % patch != 0:
            out.append(math.ceil(dim / patch) * patch)
        elif dim < patch:
            out.append(patch)
        else:
            out.append(dim)
    return tuple(out)  # type: ignore[return-value]


def zero_pad(data: np.ndarray, patch_size: tuple[int, int, int]) -> tuple[np.ndarray, tuple[int, int, int]]:
    target = padded_shape(tuple(int(v) for v in data.shape), patch_size)
    if tuple(data.shape) == target:
        return data.astype(np.float32, copy=False), target
    padded = np.zeros(target, dtype=np.float32)
    sx, sy, sz = data.shape
    padded[:sx, :sy, :sz] = data
    return padded, target


def patch_positions(shape: tuple[int, int, int], patch_size: tuple[int, int, int], overlap: float) -> list[tuple[int, int, int]]:
    steps = [max(1, round(patch * (1 - overlap))) for patch in patch_size]
    counts = []
    for dim, patch, step in zip(shape, patch_size, steps):
        if dim <= patch:
            counts.append(1)
        else:
            counts.append(max(1, math.ceil((dim - patch) / step) + 1))
    positions: list[tuple[int, int, int]] = []
    seen = set()
    for iz in range(counts[2]):
        z = iz * steps[2]
        if z + patch_size[2] > shape[2]:
            z = max(0, shape[2] - patch_size[2])
        for iy in range(counts[1]):
            y = iy * steps[1]
            if y + patch_size[1] > shape[1]:
                y = max(0, shape[1] - patch_size[1])
            for ix in range(counts[0]):
                x = ix * steps[0]
                if x + patch_size[0] > shape[0]:
                    x = max(0, shape[0] - patch_size[0])
                key = (x, y, z)
                if key not in seen:
                    seen.add(key)
                    positions.append(key)
    return positions


def gaussian_weights(patch_size: tuple[int, int, int]) -> np.ndarray:
    sigma = min(patch_size) / 8.0
    axes = [np.arange(dim, dtype=np.float32) - ((dim - 1) / 2.0) for dim in patch_size]
    xx, yy, zz = np.meshgrid(*axes, indexing="ij")
    return np.exp(-(xx * xx + yy * yy + zz * zz) / (2 * sigma * sigma)).astype(np.float32)


def run_sliding_window(
    data: np.ndarray,
    spec: ModeSpec,
    run_patch: Callable[[np.ndarray], np.ndarray],
    log: Callable[[str], None],
) -> np.ndarray:
    normalized = zscore_normalize(data)
    padded, proc_shape = zero_pad(normalized, spec.patch_size)
    weights = gaussian_weights(spec.patch_size)
    positions = patch_positions(proc_shape, spec.patch_size, spec.overlap)
    prob_accum = np.zeros(proc_shape, dtype=np.float32)
    weight_accum = np.zeros(proc_shape, dtype=np.float32)
    tta_axes = TTA_AXES if spec.tta else [()]
    total_steps = len(positions) * len(tta_axes)
    step = 0
    log(
        f"{spec.id}: shape {tuple(data.shape)} -> {proc_shape}, "
        f"{len(positions)} patches, overlap={spec.overlap}, TTA={'on' if spec.tta else 'off'}"
    )
    run_patch_batch = getattr(run_patch, "batch", None)
    for pi, (x, y, z) in enumerate(positions, start=1):
        patch = padded[x:x + spec.patch_size[0], y:y + spec.patch_size[1], z:z + spec.patch_size[2]]
        if spec.tta and run_patch_batch is not None:
            patch_inputs = []
            axes_for_patch = []
            for axes in tta_axes:
                patch_inputs.append(np.flip(patch, axis=axes).copy() if axes else patch.copy())
                axes_for_patch.append(axes)
            batch_predictions = run_patch_batch(np.stack(patch_inputs, axis=0))
            prob_sum = np.zeros(spec.patch_size, dtype=np.float32)
            for pred, axes in zip(batch_predictions, axes_for_patch):
                if axes:
                    pred = np.flip(pred, axis=axes).copy()
                prob_sum += pred.astype(np.float32, copy=False)
            step += len(tta_axes)
        else:
            prob_sum = np.zeros(spec.patch_size, dtype=np.float32)
            for axes in tta_axes:
                patch_in = np.flip(patch, axis=axes).copy() if axes else patch
                pred = run_patch(patch_in)
                if axes:
                    pred = np.flip(pred, axis=axes).copy()
                prob_sum += pred.astype(np.float32, copy=False)
                step += 1
        prob = prob_sum / float(len(tta_axes))
        prob_accum[x:x + spec.patch_size[0], y:y + spec.patch_size[1], z:z + spec.patch_size[2]] += prob * weights
        weight_accum[x:x + spec.patch_size[0], y:y + spec.patch_size[1], z:z + spec.patch_size[2]] += weights
        if pi == 1 or pi == len(positions) or step % 20 == 0:
            log(f"{spec.id}: progress {step}/{total_steps} patch steps")
    weight_accum[weight_accum == 0] = 1.0
    merged = prob_accum / weight_accum
    sx, sy, sz = data.shape
    return merged[:sx, :sy, :sz].astype(np.float32)


def ensure_current_onnx() -> Path:
    if CURRENT_ONNX_CACHE.exists() and CURRENT_ONNX_CACHE.stat().st_size > CURRENT_ONNX_MIN_BYTES:
        return CURRENT_ONNX_CACHE
    CURRENT_ONNX_CACHE.parent.mkdir(parents=True, exist_ok=True)
    print(f"Downloading current ONNX model to {CURRENT_ONNX_CACHE}")
    urllib.request.urlretrieve(CURRENT_ONNX_URL, CURRENT_ONNX_CACHE)
    if CURRENT_ONNX_CACHE.stat().st_size <= CURRENT_ONNX_MIN_BYTES:
        raise BenchmarkError(f"Downloaded ONNX model is unexpectedly small: {CURRENT_ONNX_CACHE.stat().st_size} bytes")
    return CURRENT_ONNX_CACHE


def build_onnx_runner(spec: ModeSpec) -> Callable[[np.ndarray], np.ndarray]:
    import onnxruntime as ort

    model_path = ensure_current_onnx()
    session = ort.InferenceSession(str(model_path), providers=["CPUExecutionProvider"])
    input_name = session.get_inputs()[0].name
    output_name = session.get_outputs()[0].name
    output_shape = session.get_outputs()[0].shape
    if output_shape[1] not in (None, "None", spec.out_channels):
        raise BenchmarkError(f"{spec.id}: expected {spec.out_channels} output channels, got {output_shape}")

    def run_patch(patch: np.ndarray) -> np.ndarray:
        tensor = patch[np.newaxis, np.newaxis, ...].astype(np.float32, copy=False)
        logits = session.run([output_name], {input_name: tensor})[0][0]
        if logits.shape[0] != spec.out_channels:
            raise BenchmarkError(f"{spec.id}: expected {spec.out_channels} channels, got {logits.shape}")
        return softmax_channel(logits, spec.stroke_channel)

    return run_patch


def choose_torch_device(requested: str):
    import torch

    if requested == "auto":
        if torch.backends.mps.is_available():
            return torch.device("mps")
        if torch.cuda.is_available():
            return torch.device("cuda")
        return torch.device("cpu")
    device = torch.device(requested)
    if device.type == "mps" and not torch.backends.mps.is_available():
        raise BenchmarkError("Requested --torch-device mps, but MPS is not available.")
    if device.type == "cuda" and not torch.cuda.is_available():
        raise BenchmarkError("Requested --torch-device cuda, but CUDA is not available.")
    return device


def build_torch_runner(spec: ModeSpec, requested_device: str, batch_size: int) -> Callable[[np.ndarray], np.ndarray]:
    import torch
    from huggingface_hub import hf_hub_download
    from monai.networks.nets import UNet
    from safetensors.torch import load_file

    device = choose_torch_device(requested_device)
    if not spec.repo_id:
        raise BenchmarkError(f"{spec.id}: torch mode requires repo_id")
    cfg_path = hf_hub_download(repo_id=spec.repo_id, filename="config.json")
    weights_path = hf_hub_download(repo_id=spec.repo_id, filename="model.safetensors")
    with open(cfg_path, "r", encoding="utf-8") as f:
        cfg = json.load(f)
    if int(cfg["out_channels"]) != spec.out_channels:
        raise BenchmarkError(f"{spec.id}: expected {spec.out_channels} output channels, config has {cfg['out_channels']}")
    if spec.stroke_channel >= spec.out_channels:
        raise BenchmarkError(f"{spec.id}: stroke channel {spec.stroke_channel} outside {spec.out_channels} output channels")
    model = UNet(
        spatial_dims=cfg["spatial_dims"],
        in_channels=cfg["in_channels"],
        out_channels=cfg["out_channels"],
        channels=tuple(cfg["channels"]),
        strides=tuple(cfg["strides"]),
        kernel_size=cfg["kernel_size"],
        up_kernel_size=cfg["up_kernel_size"],
        num_res_units=cfg["num_res_units"],
        act=cfg["act"],
        norm=cfg["norm"],
        dropout=cfg["dropout"],
        bias=cfg["bias"],
        adn_ordering=cfg["adn_ordering"],
    )
    missing, unexpected = model.load_state_dict(load_file(weights_path), strict=False)
    if missing or unexpected:
        raise BenchmarkError(f"{spec.id}: state_dict mismatch missing={missing[:3]} unexpected={unexpected[:3]}")
    model.to(device)
    model.eval()
    print(f"{spec.id}: using torch device {device}", flush=True)

    def run_patch(patch: np.ndarray) -> np.ndarray:
        with torch.no_grad():
            tensor = torch.from_numpy(patch[np.newaxis, np.newaxis, ...].astype(np.float32, copy=False)).to(device)
            logits = model(tensor).detach().cpu().numpy()[0]
        if logits.shape[0] != spec.out_channels:
            raise BenchmarkError(f"{spec.id}: expected {spec.out_channels} channels, got {logits.shape}")
        return softmax_channel(logits, spec.stroke_channel)

    def run_patch_batch(patches: np.ndarray) -> np.ndarray:
        predictions = []
        for start in range(0, patches.shape[0], batch_size):
            chunk = patches[start:start + batch_size]
            with torch.no_grad():
                tensor = torch.from_numpy(chunk[:, np.newaxis, ...].astype(np.float32, copy=False)).to(device)
                logits = model(tensor).detach().cpu().numpy()
            if logits.shape[1] != spec.out_channels:
                raise BenchmarkError(f"{spec.id}: expected {spec.out_channels} channels, got {logits.shape}")
            for i in range(logits.shape[0]):
                predictions.append(softmax_channel(logits[i], spec.stroke_channel))
        return np.stack(predictions, axis=0)

    run_patch.batch = run_patch_batch  # type: ignore[attr-defined]
    return run_patch


def softmax_channel(logits: np.ndarray, channel: int) -> np.ndarray:
    max_logits = np.max(logits, axis=0, keepdims=True)
    exp = np.exp(logits - max_logits)
    denom = np.sum(exp, axis=0)
    return (exp[channel] / np.maximum(denom, 1e-12)).astype(np.float32)


def remove_small_components(mask: np.ndarray, min_size: int) -> np.ndarray:
    binary = mask.astype(bool)
    if min_size <= 1 or not binary.any():
        return binary.astype(np.uint8)
    labels, num = ndimage.label(binary, structure=np.ones((3, 3, 3), dtype=np.uint8))
    if num == 0:
        return binary.astype(np.uint8)
    sizes = np.bincount(labels.ravel())
    keep = np.zeros(num + 1, dtype=bool)
    keep[np.where(sizes >= min_size)] = True
    keep[0] = False
    return keep[labels].astype(np.uint8)


def resample_binary_to_mask_grid(binary: np.ndarray, source_image: nib.Nifti1Image, mask_image: nib.Nifti1Image) -> np.ndarray:
    pred_image = nib.Nifti1Image(binary.astype(np.uint8), source_image.affine)
    resampled = resample_from_to(pred_image, (mask_image.shape[:3], mask_image.affine), order=0)
    return (np.asanyarray(resampled.dataobj) > 0).astype(np.uint8)


def metrics(pred: np.ndarray, truth: np.ndarray) -> dict[str, float | int]:
    p = pred.astype(bool)
    t = truth.astype(bool)
    tp = int(np.logical_and(p, t).sum())
    fp = int(np.logical_and(p, ~t).sum())
    fn = int(np.logical_and(~p, t).sum())
    pred_voxels = int(p.sum())
    truth_voxels = int(t.sum())
    denom_dice = 2 * tp + fp + fn
    denom_jaccard = tp + fp + fn
    return {
        "dice": (2 * tp / denom_dice) if denom_dice else 1.0,
        "jaccard": (tp / denom_jaccard) if denom_jaccard else 1.0,
        "precision": (tp / (tp + fp)) if (tp + fp) else 0.0,
        "recall": (tp / (tp + fn)) if (tp + fn) else 0.0,
        "tp": tp,
        "fp": fp,
        "fn": fn,
        "pred_voxels": pred_voxels,
        "truth_voxels": truth_voxels,
        "volume_ratio": (pred_voxels / truth_voxels) if truth_voxels else math.inf,
    }


def fov_bounds(shape: tuple[int, int, int], affine: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    corners = np.array([
        [0, 0, 0, 1],
        [shape[0], 0, 0, 1],
        [0, shape[1], 0, 1],
        [0, 0, shape[2], 1],
        [shape[0], shape[1], 0, 1],
        [shape[0], 0, shape[2], 1],
        [0, shape[1], shape[2], 1],
        [shape[0], shape[1], shape[2], 1],
    ], dtype=float)
    world = corners @ affine.T
    xyz = world[:, :3]
    return xyz.min(axis=0), xyz.max(axis=0)


def fov_warning(source: nib.Nifti1Image, target: nib.Nifti1Image) -> str | None:
    source_min, source_max = fov_bounds(source.shape[:3], source.affine)
    target_min, target_max = fov_bounds(target.shape[:3], target.affine)
    inter_min = np.maximum(source_min, target_min)
    inter_max = np.minimum(source_max, target_max)
    inter_extent = np.maximum(0, inter_max - inter_min)
    target_extent = np.maximum(0, target_max - target_min)
    target_volume = float(np.prod(target_extent))
    inter_volume = float(np.prod(inter_extent))
    overlap = inter_volume / target_volume if target_volume > 0 else 0.0
    affine_close = np.allclose(source.affine, target.affine, atol=1e-3)
    if not affine_close or overlap < 0.8:
        return f"affine/FOV differs from mask grid; target FOV overlap={overlap:.3f}"
    return None


def row_for_case(case: Case, spec: ModeSpec, threshold: float, runtime: float, note: str, values: dict[str, float | int]) -> dict[str, str | float | int]:
    row: dict[str, str | float | int] = {
        "dataset": case.dataset,
        "subject": case.subject,
        "contrast": case.contrast,
        "mode": spec.id,
        "threshold": threshold,
        "patch_size": "x".join(str(v) for v in spec.patch_size),
        "overlap": spec.overlap,
        "tta": "yes" if spec.tta else "no",
        "paired": "yes" if case.paired else "no",
        "image": str(case.image_path),
        "mask": str(case.mask_path or ""),
        "runtime_seconds": round(runtime, 3),
        "note": note,
    }
    row.update({key: round(value, 6) if isinstance(value, float) and math.isfinite(value) else value for key, value in values.items()})
    return row


def summarize(results: list[dict[str, str | float | int]], sweep: list[dict[str, str | float | int]], warnings: list[str]) -> str:
    lines = [
        "# Stroke Lesion Model Benchmark",
        "",
        "## Fixed Threshold 0.4",
        "",
        "| Dataset | Contrast | Mode | N | Mean Dice | Mean Recall | Mean Precision | Mean Volume Ratio |",
        "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |",
    ]
    paired_results = [row for row in results if row["paired"] == "yes"]
    for key, rows in grouped(paired_results, ("dataset", "contrast", "mode")):
        mean = mean_metrics(rows, ["dice", "recall", "precision", "volume_ratio"])
        lines.append(
            f"| {key[0]} | {key[1]} | {key[2]} | {len(rows)} | "
            f"{mean['dice']:.4f} | {mean['recall']:.4f} | {mean['precision']:.4f} | {mean['volume_ratio']:.3f} |"
        )

    lines += [
        "",
        "## Threshold Sweep",
        "",
        "| Dataset | Contrast | Mode | Best Threshold | Mean Dice |",
        "| --- | --- | --- | ---: | ---: |",
    ]
    paired_sweep = [row for row in sweep if row["paired"] == "yes"]
    for key, rows in grouped(paired_sweep, ("dataset", "contrast", "mode")):
        by_threshold = []
        for threshold_key, threshold_rows in grouped(rows, ("threshold",)):
            by_threshold.append((float(threshold_key[0]), mean_metrics(threshold_rows, ["dice"])["dice"]))
        best_threshold, best_dice = max(by_threshold, key=lambda item: item[1])
        lines.append(f"| {key[0]} | {key[1]} | {key[2]} | {best_threshold:.2f} | {best_dice:.4f} |")

    prediction_only = [row for row in results if row["paired"] == "no"]
    if prediction_only:
        lines += [
            "",
            "## Prediction-Only Cases",
            "",
            "| Subject | Contrast | Mode | Predicted Voxels | Runtime Seconds |",
            "| --- | --- | --- | ---: | ---: |",
        ]
        for row in prediction_only:
            lines.append(
                f"| {row['subject']} | {row['contrast']} | {row['mode']} | "
                f"{row['pred_voxels']} | {row['runtime_seconds']} |"
            )

    if warnings:
        lines += ["", "## Warnings", ""]
        for warning in warnings:
            lines.append(f"- {warning}")
    return "\n".join(lines) + "\n"


def grouped(rows: Iterable[dict[str, str | float | int]], keys: tuple[str, ...]):
    buckets: dict[tuple[str | float | int, ...], list[dict[str, str | float | int]]] = {}
    for row in rows:
        key = tuple(row[k] for k in keys)
        buckets.setdefault(key, []).append(row)
    for key in sorted(buckets):
        yield key, buckets[key]


def mean_metrics(rows: list[dict[str, str | float | int]], names: list[str]) -> dict[str, float]:
    out: dict[str, float] = {}
    for name in names:
        vals = [float(row[name]) for row in rows if isinstance(row.get(name), (int, float)) and math.isfinite(float(row[name]))]
        out[name] = sum(vals) / len(vals) if vals else math.nan
    return out


def write_csv(path: Path, rows: list[dict[str, str | float | int]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if not rows:
        path.write_text("", encoding="utf-8")
        return
    fields = list(rows[0].keys())
    with path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fields)
        writer.writeheader()
        writer.writerows(rows)


def model_runner(spec: ModeSpec, requested_device: str, batch_size: int) -> Callable[[np.ndarray], np.ndarray]:
    if spec.backend == "onnx":
        return build_onnx_runner(spec)
    if spec.backend == "torch":
        return build_torch_runner(spec, requested_device, batch_size)
    raise BenchmarkError(f"Unknown backend: {spec.backend}")


def deepisles_prediction_path(pred_root: Path, subject: str, pattern: str) -> Path:
    return pred_root / pattern.format(subject=subject)


def load_deepisles_binary_prediction(subject: str, spec: DeepIslesModeSpec, pred_root: Path) -> tuple[nib.Nifti1Image, np.ndarray, str]:
    if spec.backend == "deepisles-prediction":
        if not spec.prediction_glob:
            raise BenchmarkError(f"{spec.id}: missing prediction_glob")
        path = deepisles_prediction_path(pred_root, subject, spec.prediction_glob)
        require_file(path, f"{spec.id} prediction for {subject}")
        image, data, notes = load_nifti_3d(path, binary=True)
        return image, data, "; ".join(notes)

    if spec.backend == "deepisles-probability-mean":
        if not spec.probability_globs:
            raise BenchmarkError(f"{spec.id}: missing probability_globs")
        images: list[nib.Nifti1Image] = []
        arrays: list[np.ndarray] = []
        note_parts: list[str] = []
        for pattern in spec.probability_globs:
            path = deepisles_prediction_path(pred_root, subject, pattern)
            require_file(path, f"{spec.id} probability input for {subject}")
            image, data, notes = load_nifti_3d(path, binary=False)
            images.append(image)
            arrays.append(np.asarray(data, dtype=np.float32))
            note_parts.extend(notes)
        first = images[0]
        for image in images[1:]:
            if image.shape[:3] != first.shape[:3] or not np.allclose(image.affine, first.affine, atol=1e-3):
                raise BenchmarkError(f"{spec.id}: probability maps for {subject} are not on the same grid")
        probability = np.mean(np.stack(arrays, axis=0), axis=0)
        binary = remove_small_components(probability >= spec.probability_threshold, spec.min_component_size)
        return first, binary, "; ".join(note_parts)

    raise BenchmarkError(f"{spec.id}: unknown DeepISLES backend {spec.backend}")


def run_deepisles_prediction_modes(
    args: argparse.Namespace,
    modes: list[str],
    subjects: list[str],
    thresholds: list[float],
    results: list[dict[str, str | float | int]],
    sweep_rows: list[dict[str, str | float | int]],
    warnings: list[str],
) -> None:
    subjects_to_score = [subject for subject in subjects if subject.startswith("sub-")]
    if not subjects_to_score:
        return
    for subject in subjects_to_score:
        if subject not in SOOP_PAIRED_SUBJECTS and subject not in SOOP_PREDICTION_ONLY_SUBJECTS:
            raise BenchmarkError(f"{subject} is not in the planned SOOP subject set.")
        paired = subject in SOOP_PAIRED_SUBJECTS
        mask_path = soop_combined_mask_path(args.soop_mask_root, subject)
        if paired:
            require_file(mask_path, f"{subject} combined TRACE-space lesion mask")
            mask_image, mask_data, mask_notes = load_nifti_3d(mask_path, binary=True)
        else:
            mask_image = None
            mask_data = None
            mask_notes = []

        dwi_path = soop_image_path(args.soop_raw_root, subject, "TRACE")
        adc_path = soop_image_path(args.soop_raw_root, subject, "ADC")
        require_file(dwi_path, f"{subject} TRACE/DWI image")
        require_file(adc_path, f"{subject} ADC image")
        note_parts = [f"inputs={adc_path},{dwi_path}", "channel_order=ADC,TRACE", *[f"mask {n}" for n in mask_notes]]

        for mode in modes:
            spec = DEEPISLES_MODE_SPECS[mode]
            print(f"\nCase soop/{subject}/ADC+TRACE/{mode}", flush=True)
            t0 = time.time()
            pred_image, pred_binary, pred_note = load_deepisles_binary_prediction(subject, spec, args.deepisles_pred_root)
            runtime = time.time() - t0
            note = "; ".join([*note_parts, pred_note])
            warning = None
            if paired:
                assert mask_image is not None and mask_data is not None
                warning = fov_warning(pred_image, mask_image)
                if warning:
                    full_warning = f"{subject} ADC+TRACE {mode}: {warning}"
                    warnings.append(full_warning)
                    print(f"WARNING: {full_warning}", flush=True)
                fixed_on_mask = resample_binary_to_mask_grid(pred_binary, pred_image, mask_image)
                fixed_metrics = metrics(fixed_on_mask, mask_data)
            else:
                fixed_metrics = {
                    "dice": math.nan,
                    "jaccard": math.nan,
                    "precision": math.nan,
                    "recall": math.nan,
                    "tp": 0,
                    "fp": 0,
                    "fn": 0,
                    "pred_voxels": int(pred_binary.sum()),
                    "truth_voxels": 0,
                    "volume_ratio": math.inf,
                }

            pseudo_case = Case("soop", subject, "ADC+TRACE", dwi_path, mask_path if paired else None, paired)
            mode_as_baseline_shape = ModeSpec(
                id=spec.id,
                backend=spec.backend,
                repo_id=None,
                patch_size=spec.patch_size,
                overlap=spec.overlap,
                tta=spec.tta,
                out_channels=2,
                stroke_channel=1,
                min_component_size=spec.min_component_size,
                source=spec.source,
            )
            results.append(row_for_case(pseudo_case, mode_as_baseline_shape, args.fixed_threshold, runtime, note, fixed_metrics))
            for threshold in thresholds:
                # Prediction-backed DeepISLES modes are already binary at their
                # validated threshold; repeat the fixed metrics into the sweep
                # so summary tables stay rectangular and comparable.
                sweep_rows.append(row_for_case(pseudo_case, mode_as_baseline_shape, threshold, runtime, note, fixed_metrics))


def run_benchmark(args: argparse.Namespace) -> None:
    thresholds = parse_thresholds(args.thresholds)
    if args.fixed_threshold not in thresholds:
        thresholds = sorted(thresholds + [args.fixed_threshold])
    subjects = expand_subjects(parse_csv_list(args.subjects))
    contrasts = parse_csv_list(args.contrasts)
    modes = parse_csv_list(args.modes)
    if modes == ["all"]:
        modes = list(ALL_MODE_SPECS.keys())
    unknown_modes = [mode for mode in modes if mode not in ALL_MODE_SPECS]
    if unknown_modes:
        raise BenchmarkError(f"Unknown modes: {', '.join(unknown_modes)}")
    unknown_contrasts = [contrast for contrast in contrasts if contrast not in SOOP_CONTRASTS]
    if unknown_contrasts:
        raise BenchmarkError(f"Unknown contrasts: {', '.join(unknown_contrasts)}")
    if args.torch_batch_size < 1:
        raise BenchmarkError("--torch-batch-size must be >= 1")

    synth_modes = [mode for mode in modes if mode in MODE_SPECS]
    deepisles_modes = [mode for mode in modes if mode in DEEPISLES_MODE_SPECS]

    cases = discover_cases(args.soop_raw_root, args.soop_mask_root, subjects, contrasts)
    if args.list_cases:
        for case in cases:
            print(
                f"{case.dataset},{case.subject},{case.contrast},paired={case.paired},"
                f"image={case.image_path},mask={case.mask_path or ''}"
            )
        return

    args.out_dir.mkdir(parents=True, exist_ok=True)
    (args.out_dir / "run_config.json").write_text(json.dumps({
        "subjects": subjects,
        "contrasts": contrasts,
        "modes": modes,
        "thresholds": thresholds,
        "fixed_threshold": args.fixed_threshold,
        "torch_device": args.torch_device,
        "torch_batch_size": args.torch_batch_size,
        "soop_raw_root": str(args.soop_raw_root),
        "soop_mask_root": str(args.soop_mask_root),
    }, indent=2), encoding="utf-8")

    runners: dict[str, Callable[[np.ndarray], np.ndarray]] = {}
    results: list[dict[str, str | float | int]] = []
    sweep_rows: list[dict[str, str | float | int]] = []
    warnings: list[str] = []
    best_worst: dict[tuple[str, str, str], dict[str, dict[str, float | Path] | None]] = {}

    for mode in synth_modes:
        spec = MODE_SPECS[mode]
        print(f"\nLoading mode {spec.id}: {spec.source}", flush=True)
        runners[mode] = model_runner(spec, args.torch_device, args.torch_batch_size)
        print(
            f"Validated {spec.id}: out_channels={spec.out_channels}, "
            f"stroke_channel={spec.stroke_channel}, patch={spec.patch_size}",
            flush=True,
        )

    for case in cases:
        print(f"\nCase {case.dataset}/{case.subject}/{case.contrast}", flush=True)
        source_image, source_data, source_notes = load_nifti_3d(case.image_path)
        mask_image = None
        mask_data = None
        note_parts = list(source_notes)
        if case.mask_path:
            mask_image, mask_data, mask_notes = load_nifti_3d(case.mask_path, binary=True)
            note_parts.extend([f"mask {note}" for note in mask_notes])
            warning = fov_warning(source_image, mask_image)
            if warning:
                full_warning = f"{case.subject} {case.contrast}: {warning}"
                warnings.append(full_warning)
                print(f"WARNING: {full_warning}", flush=True)

        for mode in synth_modes:
            spec = MODE_SPECS[mode]
            t0 = time.time()
            probability = run_sliding_window(source_data, spec, runners[mode], lambda msg: print(msg, flush=True))
            runtime = time.time() - t0
            fixed_binary = remove_small_components(probability >= args.fixed_threshold, spec.min_component_size)
            note = "; ".join(note_parts)
            if case.paired:
                assert mask_image is not None and mask_data is not None
                fixed_on_mask = resample_binary_to_mask_grid(fixed_binary, source_image, mask_image)
                fixed_metrics = metrics(fixed_on_mask, mask_data)
            else:
                fixed_metrics = {
                    "dice": math.nan,
                    "jaccard": math.nan,
                    "precision": math.nan,
                    "recall": math.nan,
                    "tp": 0,
                    "fp": 0,
                    "fn": 0,
                    "pred_voxels": int(fixed_binary.sum()),
                    "truth_voxels": 0,
                    "volume_ratio": math.inf,
                }
            results.append(row_for_case(case, spec, args.fixed_threshold, runtime, note, fixed_metrics))
            if args.save_predictions == "best-worst" and case.paired:
                update_best_worst_prediction(
                    args.out_dir, best_worst, case, spec, fixed_binary, source_image, fixed_metrics
                )

            for threshold in thresholds:
                binary = remove_small_components(probability >= threshold, spec.min_component_size)
                if case.paired:
                    assert mask_image is not None and mask_data is not None
                    pred_on_mask = resample_binary_to_mask_grid(binary, source_image, mask_image)
                    values = metrics(pred_on_mask, mask_data)
                else:
                    values = {
                        "dice": math.nan,
                        "jaccard": math.nan,
                        "precision": math.nan,
                        "recall": math.nan,
                        "tp": 0,
                        "fp": 0,
                        "fn": 0,
                        "pred_voxels": int(binary.sum()),
                        "truth_voxels": 0,
                        "volume_ratio": math.inf,
                    }
                sweep_rows.append(row_for_case(case, spec, threshold, runtime, note, values))

            if args.save_predictions == "all":
                save_prediction(args.out_dir, case, spec, fixed_binary, source_image)
            write_csv(args.out_dir / "results.csv", results)
            write_csv(args.out_dir / "threshold_sweep.csv", sweep_rows)
            (args.out_dir / "summary.md").write_text(summarize(results, sweep_rows, warnings), encoding="utf-8")

    if deepisles_modes:
        run_deepisles_prediction_modes(args, deepisles_modes, subjects, thresholds, results, sweep_rows, warnings)
        write_csv(args.out_dir / "results.csv", results)
        write_csv(args.out_dir / "threshold_sweep.csv", sweep_rows)
        (args.out_dir / "summary.md").write_text(summarize(results, sweep_rows, warnings), encoding="utf-8")

    write_csv(args.out_dir / "results.csv", results)
    write_csv(args.out_dir / "threshold_sweep.csv", sweep_rows)
    (args.out_dir / "summary.md").write_text(summarize(results, sweep_rows, warnings), encoding="utf-8")
    print(f"\nWrote {args.out_dir / 'results.csv'}", flush=True)
    print(f"Wrote {args.out_dir / 'threshold_sweep.csv'}", flush=True)
    print(f"Wrote {args.out_dir / 'summary.md'}", flush=True)


def save_prediction(out_dir: Path, case: Case, spec: ModeSpec, binary: np.ndarray, source_image: nib.Nifti1Image) -> None:
    pred_dir = out_dir / "predictions"
    pred_dir.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha1(str(case.image_path).encode("utf-8")).hexdigest()[:8]
    path = pred_dir / f"{case.dataset}_{case.subject}_{case.contrast}_{spec.id}_{digest}.nii.gz"
    nib.save(nib.Nifti1Image(binary.astype(np.uint8), source_image.affine), str(path))


def update_best_worst_prediction(
    out_dir: Path,
    best_worst: dict[tuple[str, str, str], dict[str, dict[str, float | Path] | None]],
    case: Case,
    spec: ModeSpec,
    binary: np.ndarray,
    source_image: nib.Nifti1Image,
    values: dict[str, float | int],
) -> None:
    dice = float(values["dice"])
    key = (case.dataset, case.contrast, spec.id)
    state = best_worst.setdefault(key, {"best": None, "worst": None})
    for slot, better in (("best", lambda new, old: new > old), ("worst", lambda new, old: new < old)):
        current = state[slot]
        if current is None or better(dice, float(current["dice"])):
            old_path = current["path"] if current else None
            if isinstance(old_path, Path) and old_path.exists():
                old_path.unlink()
            pred_dir = out_dir / "predictions" / "best_worst"
            pred_dir.mkdir(parents=True, exist_ok=True)
            digest = hashlib.sha1(str(case.image_path).encode("utf-8")).hexdigest()[:8]
            path = pred_dir / (
                f"{slot}_{case.dataset}_{case.subject}_{case.contrast}_{spec.id}_"
                f"dice-{dice:.4f}_{digest}.nii.gz"
            )
            nib.save(nib.Nifti1Image(binary.astype(np.uint8), source_image.affine), str(path))
            state[slot] = {"dice": dice, "path": path}


def expand_subjects(subject_tokens: list[str]) -> list[str]:
    expanded: list[str] = []
    for token in subject_tokens:
        if token == "all":
            expanded.extend(["ds004884", *SOOP_PAIRED_SUBJECTS, *SOOP_PREDICTION_ONLY_SUBJECTS])
        elif token == "soop":
            expanded.extend([*SOOP_PAIRED_SUBJECTS, *SOOP_PREDICTION_ONLY_SUBJECTS])
        elif token == "paired":
            expanded.extend(SOOP_PAIRED_SUBJECTS)
        elif token == "prediction-only":
            expanded.extend(SOOP_PREDICTION_ONLY_SUBJECTS)
        else:
            expanded.append(token)
    deduped: list[str] = []
    for subject in expanded:
        if subject not in deduped:
            deduped.append(subject)
    return deduped


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--soop-raw-root", type=Path, default=DEFAULT_SOOP_RAW_ROOT)
    parser.add_argument("--soop-mask-root", type=Path, default=DEFAULT_SOOP_MASK_ROOT)
    parser.add_argument("--out-dir", type=Path, default=DEFAULT_OUT_DIR)
    parser.add_argument("--subjects", default="all", help="Comma list, or all/soop/paired/prediction-only/ds004884.")
    parser.add_argument("--contrasts", default=",".join(SOOP_CONTRASTS))
    parser.add_argument(
        "--modes",
        default=",".join(DEFAULT_MODES),
        help="Comma list of SynthStroke/SynthPlus modes, DeepISLES modes, or all.",
    )
    parser.add_argument("--thresholds", default=",".join(str(v) for v in DEFAULT_THRESHOLDS))
    parser.add_argument("--fixed-threshold", type=float, default=0.4)
    parser.add_argument("--torch-device", default="auto", help="Torch device for PyTorch modes: auto, cpu, mps, or cuda.")
    parser.add_argument("--torch-batch-size", type=int, default=4, help="Patch batch size for PyTorch modes.")
    parser.add_argument(
        "--deepisles-pred-root",
        type=Path,
        default=ROOT / ".tmp_weights" / "deepisles_onnx_run",
        help="Root containing precomputed DeepISLES NVAUTO prediction/probability NIfTIs.",
    )
    parser.add_argument("--save-predictions", choices=["none", "all", "best-worst"], default="none")
    parser.add_argument("--list-cases", action="store_true", help="Print discovered cases and exit before loading models.")
    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    try:
        run_benchmark(args)
    except BenchmarkError as exc:
        raise SystemExit(f"ERROR: {exc}") from exc


if __name__ == "__main__":
    main()
