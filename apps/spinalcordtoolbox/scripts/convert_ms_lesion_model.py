#!/usr/bin/env python3
"""
Convert one fold of SCT's contrast-agnostic MS lesion model (`sct_deepseg lesion_ms`)
to a browser-loadable ONNX file.

Expected source package (SCT 7.3 pins release r20250909, five folds):
  https://github.com/ivadomed/ms-lesion-agnostic/releases/download/r20250909/model_fold1.zip

The browser ships fold 1 only, which is what `sct_deepseg lesion_ms -single-fold`
runs. The full five-fold ensemble is about 2 GB of weights and is not converted.

The network is a two-class softmax nnU-Net (background, lesion). The exported
graph returns one channel, `logit(lesion) - logit(background)`, so that
`sigmoid(output)` equals the softmax lesion probability and the app's
`sigmoid-regions` path can threshold it at 0.5 (the argmax boundary).

Python dependencies (maintainer-only, not used at browser runtime):
  torch onnx onnxruntime dynamic-network-architectures
"""

from __future__ import annotations

import argparse
import hashlib
import json
import tempfile
import zipfile
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn
from dynamic_network_architectures.architectures.unet import ResidualEncoderUNet

EXPECTED_LABELS = {"background": 0, "lesion": 1}
EXPECTED_ORIENTATION = "RPI"
CHECKPOINT_NAMES = ("checkpoint_final.pth", "checkpoint_best.pth")


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def resolve_model_dir(source: Path, work_dir: Path) -> Path:
    if source.is_file():
        with zipfile.ZipFile(source) as zf:
            zf.extractall(work_dir)
        root = work_dir
    else:
        root = source

    matches = sorted(path for path in root.glob("**/nnUNetTrainer*__3d_fullres") if "__MACOSX" not in path.parts)
    if not matches:
        raise FileNotFoundError(f"Could not locate nnUNet 3d_fullres model directory under {root}")
    model_dir = matches[0]
    for required in ("plans.json", "dataset.json"):
        if not (model_dir / required).exists():
            raise FileNotFoundError(f"Missing {required} in {model_dir}")
    return model_dir


def resolve_checkpoint(model_dir: Path, fold: int) -> Path:
    # Same priority as SCT's create_nnunet_from_plans(): final, then best.
    for name in CHECKPOINT_NAMES:
        candidate = model_dir / f"fold_{fold}" / name
        if candidate.exists():
            return candidate
    raise FileNotFoundError(f"No checkpoint for fold {fold} in {model_dir}")


def build_model(model_dir: Path, fold: int) -> nn.Module:
    plans = json.loads((model_dir / "plans.json").read_text())
    architecture = plans["configurations"]["3d_fullres"]["architecture"]
    if not architecture["network_class_name"].endswith("ResidualEncoderUNet"):
        raise ValueError(f"Unexpected network class: {architecture['network_class_name']}")
    arch = architecture["arch_kwargs"].copy()
    arch.update({
        "conv_op": nn.Conv3d,
        "norm_op": nn.InstanceNorm3d,
        "dropout_op": None,
        "nonlin": nn.LeakyReLU,
    })
    model = ResidualEncoderUNet(input_channels=1, num_classes=2, deep_supervision=True, **arch)
    checkpoint = torch.load(resolve_checkpoint(model_dir, fold), map_location="cpu", weights_only=False)
    model.load_state_dict(checkpoint["network_weights"])
    model.eval()
    return model


class LesionLogitDifference(nn.Module):
    """Full-resolution head only, reduced to logit(lesion) - logit(background)."""

    def __init__(self, model: nn.Module) -> None:
        super().__init__()
        self.model = model

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        output = self.model(x)
        logits = output[0] if isinstance(output, (list, tuple)) else output
        return logits[:, 1:2] - logits[:, 0:1]


def export_onnx(wrapped: nn.Module, output: Path, opset: int) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    dummy = torch.randn(1, 1, 64, 64, 64)
    torch.onnx.export(
        wrapped,
        dummy,
        output,
        opset_version=opset,
        input_names=["input"],
        output_names=["logits"],
        dynamic_axes={
            "input": {0: "batch", 2: "x", 3: "y", 4: "z"},
            "logits": {0: "batch", 2: "x", 3: "y", 4: "z"},
        },
        do_constant_folding=True,
        external_data=False,
        dynamo=False,
    )


def verify_onnx(wrapped: nn.Module, output: Path) -> float:
    import onnxruntime as ort

    torch.manual_seed(0)
    sample = torch.randn(1, 1, 64, 96, 64)
    with torch.no_grad():
        expected = wrapped(sample).numpy()
    session = ort.InferenceSession(str(output), providers=["CPUExecutionProvider"])
    actual = session.run(None, {"input": sample.numpy()})[0]
    return float(np.abs(expected - actual).max())


def main() -> int:
    parser = argparse.ArgumentParser(description="Convert one fold of the SCT lesion_ms nnU-Net to a single ONNX file")
    parser.add_argument("--source", required=True, help="Path to model_fold1.zip or the extracted package")
    parser.add_argument("--fold", type=int, default=1, help="Fold to convert; SCT's -single-fold uses fold 1")
    parser.add_argument("--output", default="web/models/sct-lesion-ms.onnx")
    parser.add_argument("--opset", type=int, default=18)
    args = parser.parse_args()

    source = Path(args.source).expanduser().resolve()
    output = Path(args.output).expanduser().resolve()
    with tempfile.TemporaryDirectory(prefix="mslesion-convert-") as tmp:
        model_dir = resolve_model_dir(source, Path(tmp))
        dataset = json.loads((model_dir / "dataset.json").read_text())
        if dataset.get("labels") != EXPECTED_LABELS:
            raise ValueError(f"Unexpected lesion_ms dataset labels: {dataset.get('labels')}")
        if dataset.get("image_orientation") != EXPECTED_ORIENTATION:
            raise ValueError(f"Unexpected lesion_ms orientation: {dataset.get('image_orientation')}")
        wrapped = LesionLogitDifference(build_model(model_dir, args.fold)).eval()
        export_onnx(wrapped, output, args.opset)
        max_abs_diff = verify_onnx(wrapped, output)

    if max_abs_diff > 1e-2:
        raise RuntimeError(f"ONNX output differs from PyTorch by {max_abs_diff}")
    print(f"Wrote {output}")
    print(f"maxAbsLogitDiffVsTorch={max_abs_diff:.6g}")
    print(f"sizeBytes={output.stat().st_size}")
    print(f"checksum=sha256:{sha256(output)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
