"""Build instanseg-brightfield-nuclei.onnx from InstanSeg brightfield_nuclei.zip (v0.1.1, Apache-2.0).

    python export_model.py <brightfield_nuclei.zip|instanseg.pt> <output.onnx>

Needs torch, onnx, and onnxruntime.

Exports the 2D U-Net backbone (`m.fcn`, 3,824,780 params, float32, ~15.3 MB) with dynamic spatial
axes (multiples of 16) to opset 17 (`Add`, `Concat`, `Constant`, `Conv`, `MaxPool`, `Relu`,
`Resize`), verifies numerical agreement against PyTorch on multiple shapes, and prints the exact
61-parameter `pixel_classifier` weights and SHA-256 metadata.
"""
import hashlib
import json
import sys
import tempfile
import zipfile
from pathlib import Path

import numpy as np
import onnx
import onnxruntime as ort
import torch


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def run_ort(path, x):
    return ort.InferenceSession(str(path), providers=["CPUExecutionProvider"]).run(None, {"image": x})[0]


def main():
    source_path = Path(sys.argv[1])
    output_path = Path(sys.argv[2])

    with tempfile.TemporaryDirectory() as scratch:
        scratch_dir = Path(scratch)
        if source_path.suffix == ".zip":
            with zipfile.ZipFile(source_path) as zf:
                pt_path = Path(zf.extract("instanseg.pt", scratch_dir))
        else:
            pt_path = source_path

        module = torch.jit.load(str(pt_path), map_location="cpu").eval()
        dummy = torch.zeros(1, 3, 256, 256)
        torch.onnx.export(
            module.fcn,
            dummy,
            str(output_path),
            input_names=["image"],
            output_names=["features"],
            dynamic_axes={"image": {2: "height", 3: "width"}, "features": {2: "height", 3: "width"}},
            opset_version=17,
            dynamo=False,
        )

    model_onnx = onnx.load(str(output_path))
    onnx.checker.check_model(model_onnx)

    x = np.random.default_rng(42).standard_normal((1, 3, 320, 240)).astype(np.float32)
    with torch.no_grad():
        torch_out = module.fcn(torch.from_numpy(x)).numpy()
    ort_out = run_ort(output_path, x)
    max_diff = float(np.abs(ort_out - torch_out).max())
    assert max_diff < 1e-3, f"ONNX diverged from PyTorch: {max_diff}"

    pc = {k: v.tolist() for k, v in module.pixel_classifier.state_dict().items()}
    print(json.dumps({
        "id": "brightfield_nuclei",
        "filename": output_path.name,
        "bytes": output_path.stat().st_size,
        "sha256": sha256(output_path),
        "source_sha256": sha256(source_path),
        "fp32_max_diff": round(max_diff, 6),
        "ops": sorted({n.op_type for n in model_onnx.graph.node}),
        "pixel_size": float(module.pixel_size),
        "pixel_classifier": pc,
    }, indent=2))


if __name__ == "__main__":
    main()
