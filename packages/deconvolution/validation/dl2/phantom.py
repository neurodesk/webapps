"""Phantom, blurred and noisy image, and PSF TIFFs for the DeconvolutionLab2 comparison."""
import sys

import numpy as np
import tifffile
from scipy.signal import convolve

SHAPE = (36, 56, 56)
PSF_SHAPE = (13, 15, 15)


def main(work):
    z, y, x = np.indices(SHAPE).astype(float)
    phantom = np.zeros(SHAPE)
    for cz, cy, cx, r, v in [(18, 22, 21, 4, 80), (16, 33, 35, 6, 50), (20, 36, 19, 2.5, 120)]:
        phantom[(z - cz) ** 2 + (y - cy) ** 2 + (x - cx) ** 2 <= r * r] += v
    phantom[17:19, 15:41, 27:29] += 60
    psf = np.fromfile(f"{work}/psf.f64").reshape(PSF_SHAPE)
    psf /= psf.sum()
    blurred = np.clip(convolve(phantom, psf, mode="same"), 0, None)
    image = np.random.default_rng(7).poisson(blurred).astype(np.float64)
    image.tofile(f"{work}/image.f64")
    phantom.tofile(f"{work}/phantom.f64")
    tifffile.imwrite(f"{work}/image.tif", image.astype(np.float32))
    tifffile.imwrite(f"{work}/psf.tif", np.roll(psf, (1, 1, 1), axis=(0, 1, 2)).astype(np.float32))


if __name__ == "__main__":
    main(sys.argv[1])
