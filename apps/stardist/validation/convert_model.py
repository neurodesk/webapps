"""Convert StarDist's pretrained 2D_versatile_fluo model to ONNX.

Run once, outside the repository, in a Python 3.10 environment with
tensorflow-cpu 2.15.1, stardist 0.9.1, csbdeep 0.8.1, tf2onnx 1.16.1,
onnx 1.16.2, onnxruntime 1.19.2 and numpy < 2 (see README.md):

    python -I convert_model.py <python_2D_versatile_fluo.zip> <out-dir>

The zip is the stardist-models v0.1 release asset (BSD-3-Clause). The script
writes stardist-2d-versatile-fluo.onnx, model.json (thresholds, grid, tile
overlap) and checks that ONNX Runtime reproduces the Keras outputs.
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
from stardist.models import StarDist2D

OPSET = 17


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def main(zip_path, out_dir):
    out = Path(out_dir)
    model_dir = out / "2D_versatile_fluo"
    with zipfile.ZipFile(zip_path) as archive:
        archive.extractall(model_dir)
    model = StarDist2D(None, name=model_dir.name, basedir=str(out))
    overlap = model._axes_tile_overlap("YX")
    keras = model.keras_model
    spec = (tf.TensorSpec((None, None, None, 1), tf.float32, name="input"),)
    onnx_path = out / "stardist-2d-versatile-fluo.onnx"
    tf2onnx.convert.from_keras(keras, input_signature=spec, opset=OPSET, output_path=str(onnx_path))

    session = onnxruntime.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])
    names = [o.name for o in session.get_outputs()]
    rng = np.random.default_rng(0)
    x = rng.random((1, 256, 320, 1), dtype=np.float32)
    want = keras.predict(x, verbose=0)
    got = session.run(None, {session.get_inputs()[0].name: x})
    diffs = [float(np.max(np.abs(a - b))) for a, b in zip(want, got)]

    info = {
        "source": "https://github.com/stardist/stardist-models/releases/download/v0.1/python_2D_versatile_fluo.zip",
        "source_sha256": sha256(zip_path),
        "license": "BSD-3-Clause",
        "onnx": onnx_path.name,
        "onnx_sha256": sha256(onnx_path),
        "onnx_bytes": onnx_path.stat().st_size,
        "opset": OPSET,
        "input": session.get_inputs()[0].name,
        "outputs": names,
        "output_shapes": [list(o.shape) for o in session.get_outputs()],
        "grid": list(model.config.grid),
        "n_rays": model.config.n_rays,
        "div_by": [int(v) for v in model._axes_div_by("YX")],
        "tile_overlap": [int(v) for v in overlap],
        "thresholds": {"prob": model.thresholds.prob, "nms": model.thresholds.nms},
        "keras_vs_onnx_max_abs_diff": diffs,
        "versions": {
            "tensorflow": tf.__version__,
            "tf2onnx": tf2onnx.__version__,
            "onnxruntime": onnxruntime.__version__,
            "stardist": __import__("stardist").__version__,
        },
    }
    (out / "model.json").write_text(json.dumps(info, indent=2) + "\n")
    print(json.dumps(info, indent=2))


if __name__ == "__main__":
    main(*sys.argv[1:3])
