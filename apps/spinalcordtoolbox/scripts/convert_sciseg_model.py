#!/usr/bin/env python3
"""
Convert SCT SCIsegV2 nnUNet checkpoint packages to a browser-loadable ONNX file.

Expected source package:
  https://github.com/ivadomed/model_seg_sci/releases/download/r20240729/model_SCIsegV2_r20240729.zip

Python dependencies are intentionally explicit because this script is for
maintainers rebuilding the checked-in ONNX asset, not for browser runtime:
  torch onnx onnxruntime dynamic-network-architectures batchgenerators
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
from dynamic_network_architectures.architectures.unet import PlainConvUNet


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
    for required in ("plans.json", "dataset.json", "fold_1/checkpoint_final.pth"):
        if not (model_dir / required).exists():
            raise FileNotFoundError(f"Missing {required} in {model_dir}")
    return model_dir


def build_model(model_dir: Path) -> nn.Module:
    plans = json.loads((model_dir / "plans.json").read_text())
    arch = plans["configurations"]["3d_fullres"]["architecture"]["arch_kwargs"].copy()
    arch.update({
        "conv_op": nn.Conv3d,
        "norm_op": nn.InstanceNorm3d,
        "dropout_op": None,
        "nonlin": nn.LeakyReLU,
    })
    model = PlainConvUNet(input_channels=1, num_classes=2, deep_supervision=True, **arch)
    checkpoint = torch.load(model_dir / "fold_1/checkpoint_final.pth", map_location="cpu", weights_only=False)
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
    dummy = torch.randn(1, 1, 32, 32, 32)
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
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="Convert SCIsegV2 r20240729 to a single ONNX file")
    parser.add_argument("--source", required=True, help="Path to model_SCIsegV2_r20240729.zip or extracted package")
    parser.add_argument("--output", default="web/models/sct-lesion-sci-t2.onnx")
    parser.add_argument("--opset", type=int, default=18)
    args = parser.parse_args()

    source = Path(args.source).expanduser().resolve()
    output = Path(args.output).expanduser().resolve()
    with tempfile.TemporaryDirectory(prefix="sciseg-convert-") as tmp:
        model_dir = resolve_model_dir(source, Path(tmp))
        dataset = json.loads((model_dir / "dataset.json").read_text())
        if dataset.get("labels", {}).get("sc") != [1, 2] or dataset.get("labels", {}).get("lesion") != 2:
            raise ValueError(f"Unexpected SCIseg dataset labels: {dataset.get('labels')}")
        model = build_model(model_dir)
        export_onnx(model, output, args.opset)

    print(f"Wrote {output}")
    print(f"sizeBytes={output.stat().st_size}")
    print(f"checksum=sha256:{sha256(output)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
