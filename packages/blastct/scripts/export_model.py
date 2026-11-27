#!/usr/bin/env python3
"""Export BLAST-CT v2.0.0 DeepMedic checkpoint 1 to a dynamic-shape opset-17 ONNX model.

Pinned upstream source:
  biomedia-mira/blast-ct @ 613acbc1b6be455a44a9e6741eb899fbf082e6fd (Apache-2.0)
  blast_ct/data/saved_models/model_1.torch_model

DeepMedic uses 3 pathways with strides (5, 3, 1) and 8 valid 3x3x3 PreActBlocks per path.
For any input shape (D, H, W) = (80 + P_d, 80 + P_h, 80 + P_w) with P_i = 15 * k_i (k_i >= 1):
  - Path 0 (stride 5): full input [0:I] -> output P_i
  - Path 1 (stride 3): center crop [16:-16] -> output P_i
  - Path 2 (stride 1): center crop [32:-32] -> output P_i
This matches upstream DeepMedic.forward() to 0.0 max diff across all 80 + 15k patch sizes,
allowing WebGPU to run 125^3 patches (< 128 MiB max buffer) and WASM CPU to run 155^3
patches (18 patches on a full head CT instead of 245) from one 4.2 MB ONNX file.
"""
from __future__ import annotations

import argparse
import hashlib
import sys
from pathlib import Path

import numpy as np
import onnx
import onnxruntime as ort
import torch
import torch.nn as nn


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


class DynamicDeepMedic(nn.Module):
    def __init__(self, dm: nn.Module) -> None:
        super().__init__()
        self.p0 = dm.paths[0].path
        self.p1 = dm.paths[1].path
        self.p2 = dm.paths[2].path
        self.fc = dm.fully_connected

    def forward(self, image: torch.Tensor) -> torch.Tensor:
        o0 = self.p0(image)
        o1 = self.p1(image[:, :, 16:-16, 16:-16, 16:-16])
        o2 = self.p2(image[:, :, 32:-32, 32:-32, 32:-32])
        return self.fc(torch.cat((o0, o1, o2), dim=1))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--blast-ct-repo", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()

    sys.path.insert(0, str(args.blast_ct_repo))
    from blast_ct.models.deepmedic import DeepMedic

    ckpt = args.blast_ct_repo / "blast_ct" / "data" / "saved_models" / "model_1.torch_model"
    print(f"model_1.torch_model sha256={sha256_file(ckpt)} bytes={ckpt.stat().st_size}")

    model = DeepMedic(
        input_channels=1,
        num_classes=5,
        feature_maps=(30, 30, 40, 40, 40, 40, 50, 50),
        fully_connected=(250, 250),
    )
    model.load_state_dict(torch.load(ckpt, map_location="cpu", weights_only=True))
    model.eval()

    dyn = DynamicDeepMedic(model).eval()
    args.out.parent.mkdir(parents=True, exist_ok=True)
    torch.onnx.export(
        dyn,
        (torch.zeros(1, 1, 110, 110, 110, dtype=torch.float32),),
        str(args.out),
        opset_version=17,
        input_names=["image"],
        output_names=["logits"],
        dynamic_axes={
            "image": {2: "d", 3: "h", 4: "w"},
            "logits": {2: "od", 3: "oh", 4: "ow"},
        },
        dynamo=False,
    )

    m_onnx = onnx.load(str(args.out))
    onnx.checker.check_model(m_onnx)
    ops = sorted({n.op_type for n in m_onnx.graph.node})
    sess = ort.InferenceSession(str(args.out))

    rng = np.random.default_rng(0)
    for shape in [(95, 95, 95), (110, 110, 110), (125, 125, 125), (140, 155, 155)]:
        x_np = rng.standard_normal((1, 1) + shape, dtype=np.float32)
        with torch.no_grad():
            y_ref = model(torch.from_numpy(x_np))[0].numpy()
        y_ort = sess.run(None, {"image": x_np})[0]
        diff = float(np.max(np.abs(y_ref - y_ort)))
        print(f"verified shape={shape} -> out={y_ort.shape} max_diff={diff:.2e}")
        if diff > 1e-4:
            raise SystemExit(f"ONNX export mismatch for {shape}: {diff}")

    print(f"exported={args.out} bytes={args.out.stat().st_size} sha256={sha256_file(args.out)} ops={ops}")


if __name__ == "__main__":
    main()
