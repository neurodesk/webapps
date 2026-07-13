#!/usr/bin/env python3
"""
Convert TotalSpineSeg step-1 nnU-Net checkpoints to browser-loadable ONNX.

Expected source package:
  https://github.com/neuropoly/totalspineseg/releases/download/r20251124/Dataset101_TotalSpineSeg_step1_r20251124.zip

Python dependencies are intentionally explicit because this script is for
maintainers rebuilding the checked-in ONNX asset, not for browser runtime:
  torch onnx onnxruntime dynamic-network-architectures
"""

from __future__ import annotations

import argparse
import hashlib
import json
import tempfile
import zipfile
from pathlib import Path

import torch
import torch.nn as nn
from dynamic_network_architectures.architectures.unet import ResidualEncoderUNet


EXPECTED_REGIONS_CLASS_ORDER = [1, 2, 3, 4, 5, 6, 7, 8, 9]


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

    matches = sorted(root.glob("**/nnUNetTrainer*__nnUNetPlans__3d_fullres"))
    if not matches:
        raise FileNotFoundError(f"Could not locate nnUNet 3d_fullres model directory under {root}")
    model_dir = matches[0]
    for required in ("plans.json", "dataset.json", "fold_0/checkpoint_best.pth"):
        if not (model_dir / required).exists():
            raise FileNotFoundError(f"Missing {required} in {model_dir}")
    return model_dir


def build_model(model_dir: Path) -> nn.Module:
    plans = json.loads((model_dir / "plans.json").read_text())
    dataset = json.loads((model_dir / "dataset.json").read_text())
    if dataset.get("regions_class_order") != EXPECTED_REGIONS_CLASS_ORDER:
        raise ValueError(f"Unexpected TotalSpineSeg regions_class_order: {dataset.get('regions_class_order')}")

    arch = plans["configurations"]["3d_fullres"]["architecture"]["arch_kwargs"].copy()
    arch.update({
        "conv_op": nn.Conv3d,
        "norm_op": nn.InstanceNorm3d,
        "dropout_op": None,
        "nonlin": nn.LeakyReLU,
    })
    model = ResidualEncoderUNet(
        input_channels=1,
        num_classes=len(EXPECTED_REGIONS_CLASS_ORDER),
        deep_supervision=True,
        **arch,
    )
    checkpoint = torch.load(model_dir / "fold_0/checkpoint_best.pth", map_location="cpu", weights_only=False)
    model.load_state_dict(checkpoint["network_weights"])
    model.eval()
    return model


class FirstDeepSupervisionOutput(nn.Module):
    def __init__(self, model: nn.Module) -> None:
        super().__init__()
        self.model = model

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        output = self.model(x)
        return output[0] if isinstance(output, (list, tuple)) else output


def export_onnx(model: nn.Module, output: Path, opset: int) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    wrapped = FirstDeepSupervisionOutput(model).eval()
    # The residual encoder downsamples x/y by 64 and z by 16. Smaller dummy
    # shapes fail during export even though the exported graph keeps dynamic axes.
    dummy = torch.randn(1, 1, 128, 128, 32)
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


def main() -> int:
    parser = argparse.ArgumentParser(description="Convert TotalSpineSeg step-1 r20251124 to a single ONNX file")
    parser.add_argument("--source", required=True, help="Path to Dataset101_TotalSpineSeg_step1_r20251124.zip or extracted package")
    parser.add_argument("--output", default="web/models/totalspineseg-step1.onnx")
    parser.add_argument("--opset", type=int, default=18)
    args = parser.parse_args()

    source = Path(args.source).expanduser().resolve()
    output = Path(args.output).expanduser().resolve()
    with tempfile.TemporaryDirectory(prefix="totalspineseg-convert-") as tmp:
        model_dir = resolve_model_dir(source, Path(tmp))
        model = build_model(model_dir)
        export_onnx(model, output, args.opset)

    print(f"Wrote {output}")
    print(f"sizeBytes={output.stat().st_size}")
    print(f"checksum=sha256:{sha256(output)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
