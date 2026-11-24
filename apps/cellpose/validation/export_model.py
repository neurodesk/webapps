"""Export Cellpose 3.1.1.1 PyTorch models (cyto3, nuclei) to dynamic-shape ONNX.

Environment:
    python3.10 -m venv venv
    venv/bin/pip install torch==2.5.1+cpu --index-url https://download.pytorch.org/whl/cpu
    venv/bin/pip install cellpose==3.1.1.1 onnx==1.16.2 onnxruntime==1.19.2 "numpy<2"

Usage:
    venv/bin/python export_model.py <output-dir>
"""

import hashlib
import json
import sys
from pathlib import Path

import numpy as np
import onnx
import onnxruntime as ort
import torch
from cellpose import models

MODELS = [
    ("cyto3", "cellpose-cyto3.onnx"),
    ("nuclei", "cellpose-nuclei.onnx"),
]


class ExportWrapper(torch.nn.Module):
    def __init__(self, net):
        super().__init__()
        self.net = net

    def forward(self, x):
        out = self.net(x)
        return out[0], out[1]


def dynamic_make_style(x):
    """Equivalent to CPnet.make_style without shape-dependent avg_pool2d kernel_size."""
    style = x.mean(dim=(-2, -1))
    return style / torch.sum(style**2, dim=1, keepdim=True) ** 0.5


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def export_one(model_type: str, out_path: Path):
    model = models.CellposeModel(gpu=False, mkldnn=False, model_type=model_type)
    net = model.net
    net.eval()
    net.make_style = dynamic_make_style
    wrapper = ExportWrapper(net).eval()

    dummy = torch.randn(1, 2, 224, 224, dtype=torch.float32)
    torch.onnx.export(
        wrapper,
        dummy,
        str(out_path),
        opset_version=17,
        input_names=["input"],
        output_names=["flows", "style"],
        dynamic_axes={
            "input": {0: "batch", 2: "height", 3: "width"},
            "flows": {0: "batch", 2: "height", 3: "width"},
            "style": {0: "batch"},
        },
        do_constant_folding=True,
    )
    onnx.checker.check_model(str(out_path))

    sess = ort.InferenceSession(str(out_path), providers=["CPUExecutionProvider"])
    max_flow_diff = 0.0
    max_style_diff = 0.0
    rng = np.random.default_rng(42)
    for shape in ((1, 2, 224, 224), (2, 2, 160, 192)):
        sample = rng.standard_normal(shape, dtype=np.float32)
        with torch.no_grad():
            pt_flows, pt_style = wrapper(torch.from_numpy(sample))
        ort_flows, ort_style = sess.run(None, {"input": sample})
        max_flow_diff = max(max_flow_diff, float(np.max(np.abs(pt_flows.numpy() - ort_flows))))
        max_style_diff = max(max_style_diff, float(np.max(np.abs(pt_style.numpy() - ort_style))))

    source_path = Path(model.pretrained_model[0]) if isinstance(model.pretrained_model, list) else Path(model.pretrained_model)
    return {
        "model": model_type,
        "filename": out_path.name,
        "bytes": out_path.stat().st_size,
        "sha256": sha256_file(out_path),
        "diam_mean": float(model.diam_mean),
        "source_path": source_path.name,
        "source_sha256": sha256_file(source_path),
        "max_abs_diff": {"flows": max_flow_diff, "style": max_style_diff},
    }


def main():
    if len(sys.argv) != 2:
        raise SystemExit(f"Usage: {sys.argv[0]} <output-dir>")
    out_dir = Path(sys.argv[1])
    out_dir.mkdir(parents=True, exist_ok=True)
    summary = [export_one(name, out_dir / filename) for name, filename in MODELS]
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
