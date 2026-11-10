"""scikit-image Richardson-Lucy references (packages/deconvolution/test/rl.test.js).

Each case stores its inputs and skimage.restoration.richardson_lucy(image, psf, num_iter,
clip=False) as little-endian float64, base64 encoded, so the Node test feeds the WebAssembly
module the identical bytes. The sizes are odd, the padded FFT grids are not powers of two, and
one PSF has even sides, so every crop offset of scipy's mode="same" is exercised.

Run with the pinned requirements: python -I rl_reference.py > rl-reference.json
"""
import base64
import json
import sys

import numpy as np
import scipy
import skimage

sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parent))
from skimage.restoration import richardson_lucy

import psf_reference  # noqa: E402


def encode(array):
    return base64.b64encode(np.ascontiguousarray(array, dtype="<f8").tobytes()).decode()


def phantom(shape, rng):
    z, y, x = np.indices(shape).astype(float)
    image = np.full(shape, 2.0)
    for _ in range(4):
        centre = [rng.uniform(1, n - 2) for n in shape]
        radius = rng.uniform(1.0, 3.0)
        image += rng.uniform(20, 120) * np.exp(-((z - centre[0]) ** 2 + (y - centre[1]) ** 2 + (x - centre[2]) ** 2) / (2 * radius ** 2))
    return rng.poisson(image).astype(float)


def main():
    rng = np.random.default_rng(20261105)
    # A Gibson-Lanni widefield PSF from psfmodels, odd sides, summing to 1.
    case = dict(psf_reference.CASES[0], xy=9, nz=7)
    gl = psf_reference.psfmodels_volume(case, case["emission"])
    gl /= gl.sum()
    even = rng.uniform(0.1, 1.0, size=(4, 6, 5))
    even /= even.sum()
    cases = [
        dict(id="odd-gibson-lanni", image=phantom((11, 18, 15), rng), psf=gl, iterations=10),
        dict(id="even-psf", image=phantom((9, 14, 13), rng), psf=even, iterations=6),
    ]
    out = {
        "generator": "packages/deconvolution/validation/rl_reference.py",
        "versions": {"scikit-image": skimage.__version__, "scipy": scipy.__version__, "numpy": np.__version__},
        "call": "richardson_lucy(image, psf, num_iter=iterations, clip=False)",
        "cases": [],
    }
    for c in cases:
        result = richardson_lucy(c["image"], c["psf"], num_iter=c["iterations"], clip=False)
        out["cases"].append({
            "id": c["id"],
            "dims": list(c["image"].shape),
            "psfDims": list(c["psf"].shape),
            "iterations": c["iterations"],
            "image": encode(c["image"]),
            "psf": encode(c["psf"]),
            "expected": encode(result),
        })
    json.dump(out, sys.stdout, indent=1)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
