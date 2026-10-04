#!/usr/bin/env python3

import contextlib
import hashlib
import io
import json
import platform
from pathlib import Path

import monai
import numpy as np
import torch
from monai.data import MetaTensor
from monai.networks.utils import to_norm_affine
from monai.transforms import Spacing


def sparse(values):
    return [[i, float(value)] for i, value in enumerate(values.flatten(order="F")) if value != 0]


def fixture(name, dims, affine, spacing, sparse_input=False):
    indices = np.arange(np.prod(dims)).reshape(dims, order="F")
    data = ((indices * 17 % 31) - 14).astype(np.float32) / 8
    if name == "corner-cancellation":
        data = np.array([1e20, 1, -1e20, 1, 1, 1, 1, 1], dtype=np.float32).reshape(dims, order="F")
    if name == "mixed-magnitudes":
        values = np.array([1e20, -1e20, .1, -3, 7, 1e-20, -1e-20], dtype=np.float32)
        data = values[indices % len(values)]
    if sparse_input:
        data.fill(0)
        data[tuple(size // 2 for size in dims)] = 7
        data[tuple(max(0, size // 2 - 1) for size in dims)] = -3
    result = Spacing(pixdim=spacing, mode="bilinear")(MetaTensor(data[None], affine=affine))
    output_dims = list(result.shape[1:])
    output_affine = result.affine.numpy()
    solved = np.linalg.solve(affine, output_affine)
    normalized = to_norm_affine(torch.tensor(solved)[None], dims, output_dims, align_corners=False)[0]
    theta = normalized[[2, 1, 0, 3]][:, [2, 1, 0, 3]]
    grid = torch.nn.functional.affine_grid(theta[:3][None], [1, 1, *output_dims], align_corners=False)[0]
    coordinates = ((grid + 1) * torch.tensor(dims[::-1]) - 1) / 2
    samples = []
    for point in [(0, 0, 0), tuple(size // 2 for size in output_dims), tuple(size - 1 for size in output_dims)]:
        samples.append({"output": list(point), "source": coordinates[point].flip(0).tolist()})
    return {
        "name": name,
        "dims": dims,
        "affine": affine.tolist(),
        "spacing": spacing,
        "input": sparse(data),
        "outputDims": output_dims,
        "outputAffine": output_affine.tolist(),
        "sourceFromOutput": solved.tolist(),
        "theta": theta.tolist(),
        "points": samples,
        "output": sparse(result[0].numpy()),
    }


def main():
    if (monai.__version__, torch.__version__.split("+")[0], np.__version__) != ("1.3.2", "2.4.1", "1.26.4"):
        raise SystemExit("Use MONAI 1.3.2, torch 2.4.1 and NumPy 1.26.4")
    torch.set_num_threads(1)
    root = Path(__file__).parents[1] / "test" / "fixtures"
    data = np.zeros((4, 3, 17), dtype=np.float32)
    data[1:3, 1, 2] = [3, 7]
    data[1:3, 1, 3] = [5, 9]
    data[2, 2, 12] = 11
    affine = np.diag([1.4, 1.2, 2, 1])
    affine[:3, 3] = [10, -20, 30]
    result = Spacing(pixdim=(1, 1, -1), mode="bilinear")(MetaTensor(data[None], affine=affine))
    native = {
        "source": "MONAI 1.3.2 / torch 2.4.1, Spacing((1,1,-1), mode=bilinear), default float64",
        "dims": list(data.shape), "affine": affine.tolist(), "input": sparse(data),
        "outputDims": list(result.shape[1:]), "output": sparse(result[0].numpy()),
    }
    (root / "monai-native-depth17.json").write_text(json.dumps(native, indent=2) + "\n")
    cases = []
    for name, dims, linear, spacing, zeros in [
        ("identity", [4, 3, 5], np.eye(3), [1, 1, 1], True),
        ("anisotropic", [4, 3, 5], np.diag([1.4, 1.2, 2]), [1, 1, -1], True),
        ("odd-midpoint", [4, 3, 11], np.diag([1.4, 1.2, 2]), [1, 1, -1], True),
        ("even-depth", [4, 3, 6], np.diag([1.4, 1.2, 2]), [1, 1, -1], True),
        ("knee-geometry", [4, 5, 8], np.diag([1.875, 5, 1.875]), [1, 1, -1], True),
        ("body-geometry", [4, 3, 17], np.diag([1.2812999486923218, 1.2812999486923218, 3]), [1, 1, -1], True),
        ("half-even-extent", [4, 3, 3], np.diag([0.5, 1.25, 1]), [1, 1, 1], False),
        ("row-exchange", [3, 4, 5], np.array([[0, -1.2, 0], [1.4, 0, 0], [0, 0, 2]]), [1, 1, -1], False),
        ("shear", [4, 3, 5], np.array([[1.4, .4, -.3], [0, 1.2, .2], [0, 0, 2]]), [1, 1, -1], False),
        ("corner-cancellation", [2, 2, 2], np.diag([2, 2, 2]), [1, 1, 1], False),
        ("mixed-magnitudes", [4, 3, 5], np.array([[1.4, .4, -.3], [0, 1.2, .2], [0, 0, 2]]), [1, 1, -1], False),
        ("negative-shear", [4, 3, 5], np.array([[1.4, -.4, .3], [0, 1.2, -.2], [0, 0, 2]]), [1, 1, -1], False),
    ]:
        matrix = np.eye(4)
        matrix[:3, :3] = linear
        matrix[:3, 3] = [10, -20, 30]
        cases.append(fixture(name, dims, matrix, spacing, zeros))
    for axis in range(3):
        matrix = np.diag([1.4, 1.2, 2, 1])
        dims = [4, 3, 5]
        dims[axis] = 1
        cases.append(fixture(f"singleton-{axis}", dims, matrix, [1, 1, -1], True))
        rotation = np.eye(3)
        a, b = [index for index in range(3) if index != axis]
        rotation[a, a] = rotation[b, b] = np.cos(.37)
        rotation[a, b] = -np.sin(.37)
        rotation[b, a] = np.sin(.37)
        matrix[:3, :3] = rotation @ np.array([[1.4, -.4, .3], [0, 1.2, -.2], [0, 0, 2]])
        matrix[:3, 3] = [-7.2, 4.1, 19.7]
        cases.append(fixture(f"rotated-shear-{axis}", [4, 3, 5], matrix, [1, 1, -1]))
    cases.append(fixture("all-singleton", [1, 1, 1], np.eye(4), [1, 1, 1], True))
    config = io.StringIO()
    with contextlib.redirect_stdout(config):
        np.show_config()
    sources = {}
    for relative in ["data/utils.py", "networks/utils.py", "networks/layers/spatial_transforms.py", "transforms/spatial/functional.py"]:
        path = Path(monai.__file__).parent / relative
        sources[relative] = hashlib.sha256(path.read_bytes()).hexdigest()
    all_axes = hashlib.sha256()
    for size in range(1, 1025):
        axis = torch.zeros(1, dtype=torch.float64) if size == 1 else torch.linspace(-1, 1, size, dtype=torch.float64) * (size - 1) / size
        all_axes.update(axis.numpy().astype("<f8").tobytes())
    suite = {
        "axes1Through1024Sha256": all_axes.hexdigest(),
        "environment": {"monai": monai.__version__, "torch": torch.__version__, "numpy": np.__version__,
                        "platform": platform.platform(), "threads": torch.get_num_threads(),
                        "numpyConfig": config.getvalue(), "torchConfig": torch.__config__.show(), "sourceSha256": sources},
        "axes": [{"size": size, "values": (torch.linspace(-1, 1, size, dtype=torch.float64) * (size - 1) / size).tolist()}
                 for size in [2, 3, 6, 7, 11, 17, 45, 256, 307, 358, 410]],
        "cases": cases,
    }
    (root / "monai-resampling-stages.json").write_text(json.dumps(suite, indent=2) + "\n")


if __name__ == "__main__":
    main()
