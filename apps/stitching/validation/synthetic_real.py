"""Cuts a 3 x 3 mosaic with known sub-pixel offsets out of one real tile of the example.

    python -I synthetic_real.py <example tile .tif> <output directory>

The source is one 1392 x 1040 phase-contrast tile of the NIST MIST example. Each output tile is
the source moved by its true position's fractional part with the Fourier shift theorem (exact
for band-limited content; numpy's FFT, independent of the app's) and then cropped at the
integer part, 48 px inside the source edges so the periodic wrap of the shift never reaches a
tile. Every tile gets its own Gaussian noise (sigma = 2 % of the source's standard deviation),
so overlaps are not identical copies. The approximate layout is the regular 400 x 280 px grid;
the true positions are that grid moved by up to 12 px per axis. Writes the tiles (float32
TIFF), TileConfiguration.txt (the approximate layout) and truth.json.
"""
import json
import sys

import numpy as np
import tifffile

MARGIN = 48
SHAPE = (340, 480)  # rows, columns
STEP = (280, 400)
JITTER = 12.0


def shifted(image, dy, dx):
    rows, cols = image.shape
    ky = np.fft.fftfreq(rows)[:, None]
    kx = np.fft.fftfreq(cols)[None, :]
    spectrum = np.fft.fft2(image) * np.exp(2j * np.pi * (ky * dy + kx * dx))
    return np.fft.ifft2(spectrum).real


def main(source_path, out):
    source = tifffile.imread(source_path).astype(np.float64)
    rng = np.random.default_rng(20261105)
    noise = 0.02 * source.std()
    entries = []
    truth = {}
    for row in range(3):
        for column in range(3):
            name = f"tile_r{row + 1}_c{column + 1}.tif"
            grid = np.array([column * STEP[1], row * STEP[0]], dtype=float)
            position = grid + rng.uniform(0, 2 * JITTER, size=2)
            integer = np.floor(position).astype(int)
            fraction = position - integer
            # tile(x) = source(MARGIN + position + x): move the source by -fraction, then crop.
            moved = shifted(source, fraction[1], fraction[0])
            y0 = MARGIN + integer[1]
            x0 = MARGIN + integer[0]
            tile = moved[y0:y0 + SHAPE[0], x0:x0 + SHAPE[1]]
            assert tile.shape == SHAPE
            tile = tile + rng.normal(0, noise, size=SHAPE)
            tifffile.imwrite(f"{out}/{name}", tile.astype(np.float32))
            entries.append(f"{name}; ; ({grid[0]:.1f}, {grid[1]:.1f})")
            truth[name] = position.tolist()
    with open(f"{out}/TileConfiguration.txt", "w") as handle:
        handle.write("# Define the number of dimensions we are working on\ndim = 2\n\n# Define the image coordinates\n")
        handle.write("\n".join(entries) + "\n")
    with open(f"{out}/truth.json", "w") as handle:
        json.dump(truth, handle, indent=2)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
