"""Convert StarDist's pretrained 2D and 3D models to ONNX.

Run once, outside the repository, in a Python 3.10 environment with
tensorflow-cpu 2.15.1, stardist 0.9.1, csbdeep 0.8.1, tf2onnx 1.16.1,
onnx 1.16.2, onnxruntime 1.19.2, setuptools < 81 and numpy < 2 (see README.md):

    python -I convert_model.py <python_<name>.zip> <out-dir>

The zip is a stardist-models v0.1 release asset (BSD-3-Clause):
python_2D_versatile_fluo.zip, python_2D_versatile_he.zip,
python_2D_paper_dsb2018.zip or python_3D_demo.zip. The script writes
stardist-<slug>.onnx, <name>.json (thresholds, grid, div_by, tile_overlap, and
3D rays when applicable) and checks that ONNX Runtime reproduces the Keras
outputs.
"""

import hashlib
import json
import sys
import zipfile
from pathlib import Path

import numpy as np
import onnxruntime
import tensorflow as tf
import tf2onnx
from stardist.models import StarDist2D, StarDist3D
from stardist.rays3d import rays_from_json

OPSET = 17
RELEASE_BASE = "https://github.com/stardist/stardist-models/releases/download/v0.1/"


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def main(zip_path, out_dir):
    zip_file = Path(zip_path)
    name = zip_file.stem.removeprefix("python_")
    is_3d = name.startswith("3D_")
    out = Path(out_dir)
    model_dir = out / name
    with zipfile.ZipFile(zip_file) as archive:
        archive.extractall(model_dir)
    cls = StarDist3D if is_3d else StarDist2D
    model = cls(None, name=model_dir.name, basedir=str(out))
    axes = "ZYX" if is_3d else "YX"
    overlap = model._axes_tile_overlap(axes)
    div_by = model._axes_div_by(axes)
    n_channels = int(model.config.n_channel_in)
    keras = model.keras_model
    input_shape = (None, None, None, None, n_channels) if is_3d else (None, None, None, n_channels)
    spec = (tf.TensorSpec(input_shape, tf.float32, name="input"),)
    slug = name.lower().replace("_", "-")
    onnx_path = out / f"stardist-{slug}.onnx"
    tf2onnx.convert.from_keras(keras, input_signature=spec, opset=OPSET, output_path=str(onnx_path))

    session = onnxruntime.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])
    names = [o.name for o in session.get_outputs()]
    rng = np.random.default_rng(0)
    probe_shape = (1, 32, 64, 64, n_channels) if is_3d else (1, 256, 320, n_channels)
    x = rng.random(probe_shape, dtype=np.float32)
    want = keras.predict(x, verbose=0)
    got = session.run(None, {session.get_inputs()[0].name: x})
    diffs = [float(np.max(np.abs(a - b))) for a, b in zip(want, got)]
    weights = model_dir / "weights_best.h5"
    if not weights.exists():
        weights = model_dir / "weights_last.h5"

    info = {
        "name": name,
        "source": RELEASE_BASE + zip_file.name,
        "source_sha256": sha256(zip_file),
        "weights_file": weights.name,
        "weights_sha256": sha256(weights),
        "license": "BSD-3-Clause",
        "onnx": onnx_path.name,
        "onnx_sha256": sha256(onnx_path),
        "onnx_bytes": onnx_path.stat().st_size,
        "opset": OPSET,
        "axes": model.config.axes,
        "n_channel_in": n_channels,
        "input": session.get_inputs()[0].name,
        "outputs": names,
        "output_shapes": [list(o.shape) for o in session.get_outputs()],
        "grid": [int(v) for v in model.config.grid],
        "n_rays": int(model.config.n_rays),
        "div_by": [int(v) for v in div_by],
        "tile_overlap": [int(v) for v in overlap],
        "thresholds": {"prob": float(model.thresholds.prob), "nms": float(model.thresholds.nms)},
        "keras_vs_onnx_max_abs_diff": diffs,
        "versions": {
            "tensorflow": tf.__version__,
            "tf2onnx": tf2onnx.__version__,
            "onnxruntime": onnxruntime.__version__,
            "stardist": __import__("stardist").__version__,
        },
    }
    if is_3d:
        rays = rays_from_json(model.config.rays_json)
        info["anisotropy"] = [float(v) for v in model.config.anisotropy]
        info["rays_json"] = model.config.rays_json
        rays_path = out / f"rays-{slug}.json"
        rays_path.write_text(
            json.dumps(
                {
                    "name": model.config.rays_json["name"],
                    "n_rays": int(model.config.n_rays),
                    "anisotropy": info["anisotropy"],
                    "vertices": [[float(c) for c in row] for row in rays.vertices],
                    "faces": [[int(c) for c in row] for row in rays.faces],
                },
                indent=2,
            )
            + "\n"
        )
    (out / f"{name}.json").write_text(json.dumps(info, indent=2) + "\n")
    print(json.dumps(info, indent=2))


if __name__ == "__main__":
    main(*sys.argv[1:3])
