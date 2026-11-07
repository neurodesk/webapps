"""Pillow and micro-sam preprocessing on synthetic images, for test/preprocess.test.js.

python -I preprocess_reference.py <out.json>

Each case builds a deterministic image from the formula in `pattern` (test/preprocess.test.js
builds the same one), runs micro_sam.util._to_image and SAM's ResizeLongestSide.apply_image (the
torchvision resize micro-sam's SamPredictor uses, Pillow's bilinear filter), and records SHA-256
digests of the uint8 image and the resized image, and of the float32 encoder tensor that
Sam.preprocess makes from the resized image.
"""
import hashlib
import json
import sys

import numpy as np
import PIL
import torch
from micro_sam import util
from mobile_sam.utils.transforms import ResizeLongestSide

PIXEL_MEAN = torch.tensor([123.675, 116.28, 103.53]).view(-1, 1, 1)
PIXEL_STD = torch.tensor([58.395, 57.12, 57.375]).view(-1, 1, 1)

# (height, width, channels, dtype): upsampling, downsampling in one or both axes, the
# vertical-first branch (height reduced more than twice the width), odd sizes, no resize.
CASES = [
    (360, 360, 1, "uint8"),
    (157, 203, 1, "uint16"),
    (700, 1500, 3, "uint8"),
    (3000, 900, 1, "uint16"),
    (1024, 800, 1, "float32"),
    (512, 2048, 2, "uint16"),
    (37, 1000, 1, "float32"),
    (999, 1001, 3, "uint16"),
]


def pattern(height, width, channels, dtype):
    y, x = np.mgrid[0:height, 0:width].astype(np.int64)
    planes = []
    for c in range(channels):
        value = (x * 31 + y * 17 + c * 7 + ((x * y) >> 3)) % 251
        value = value * (1 + (x // 64 + y // 48) % 3)
        if dtype == "uint16":
            planes.append((value * 97 % 65521).astype(np.uint16))
        elif dtype == "float32":
            planes.append((value.astype(np.float32) * np.float32(0.37) - np.float32(12.5)))
        else:
            planes.append((value % 256).astype(np.uint8))
    return planes[0] if channels == 1 else np.stack(planes, axis=-1)


def digest(array):
    return hashlib.sha256(np.ascontiguousarray(array).tobytes()).hexdigest()


def main(out_path):
    transform = ResizeLongestSide(1024)
    cases = []
    for height, width, channels, dtype in CASES:
        image = pattern(height, width, channels, dtype)
        uint8 = util._to_image(image)
        resized = transform.apply_image(uint8)
        tensor = torch.as_tensor(resized).permute(2, 0, 1).float()
        tensor = (tensor - PIXEL_MEAN) / PIXEL_STD
        h, w = tensor.shape[-2:]
        tensor = torch.nn.functional.pad(tensor, (0, 1024 - w, 0, 1024 - h))
        cases.append({
            "height": height, "width": width, "channels": channels, "dtype": dtype,
            "input_sha256": digest(image),
            "uint8_sha256": [digest(uint8[..., c]) for c in range(3)],
            "resized": list(resized.shape[:2]),
            "resized_sha256": [digest(resized[..., c]) for c in range(3)],
            "tensor_sha256": digest(tensor.numpy().astype(np.float32)),
        })
    versions = {"pillow": PIL.__version__, "torch": torch.__version__, "numpy": np.__version__}
    with open(out_path, "w") as f:
        json.dump({"versions": versions, "cases": cases}, f, indent=1)
        f.write("\n")


if __name__ == "__main__":
    main(sys.argv[1])
