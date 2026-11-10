"""Small CaImAn and scikit-image references for the unit tests (test/fixtures/caiman-reference.json).

CaImAn (GPL-2) and scikit-image (BSD-3) are external references only; no code from them is in
the app. The frames are odd-sized (45 x 52) so the app's Bluestein FFT path is checked too.
The eight-neighbour correlation reference is computed per pixel with numpy.corrcoef.

    python -I unit_reference.py <out.json>
"""
import json
import sys

import numpy as np
from caiman.motion_correction import register_translation
from caiman.summary_images import local_correlations
from scipy.ndimage import gaussian_filter, shift as nd_shift
from skimage.registration import phase_cross_correlation


def main(out):
    rng = np.random.default_rng(2017)
    height, width = 45, 52
    template = gaussian_filter(rng.random((height, width)), 2.0) * 1000 + 100
    truth = [[1.3, -2.7], [-0.45, 0.8], [3.05, 2.2], [0.0, -4.6], [-2.25, -1.15]]
    frames = []
    for dy, dx in truth:
        moved = nd_shift(template, (dy, dx), order=3, mode="wrap")
        frames.append(np.round(moved + rng.normal(0, 5, moved.shape), 4))
    template = np.round(template, 4)
    caiman = []
    phase = []
    for frame in frames:
        shift, _, _ = register_translation(template, frame, upsample_factor=20, shifts_lb=(-8, -8), shifts_ub=(8, 8), max_shifts=(8, 8))
        caiman.append([float(v) for v in shift])
        shift, _, _ = phase_cross_correlation(template, frame, upsample_factor=20, normalization="phase")
        phase.append([float(v) for v in shift])
    movie = np.round(gaussian_filter(rng.normal(0, 1, (17, 20, 30)), (0, 1, 1)) + rng.normal(0, 0.3, (17, 20, 30)), 5)
    four = local_correlations(movie, eight_neighbours=False, swap_dim=False)
    # CaImAn's eight-neighbour image adds the diagonal terms to the wrong pixels, so the
    # eight-neighbour reference is the per-pixel definition: the mean Pearson r with each neighbour.
    _, height2, width2 = movie.shape
    eight = np.zeros((height2, width2))
    for y in range(height2):
        for x in range(width2):
            values = [np.corrcoef(movie[:, y, x], movie[:, y + dy, x + dx])[0, 1]
                      for dy in (-1, 0, 1) for dx in (-1, 0, 1)
                      if (dy or dx) and 0 <= y + dy < height2 and 0 <= x + dx < width2]
            eight[y, x] = np.mean(values)
    result = {
        "registration": {
            "height": height,
            "width": width,
            "upsample": 20,
            "maxShift": 8,
            "template": template.ravel().tolist(),
            "frames": [frame.ravel().tolist() for frame in frames],
            "truth": [[-dy, -dx] for dy, dx in truth],
            "caiman": caiman,
            "skimagePhase": phase,
        },
        "localCorrelations": {
            "frames": 17,
            "height": 20,
            "width": 30,
            "movie": movie.ravel().tolist(),
            "caimanFourNeighbours": four.ravel().tolist(),
            "pearsonEightNeighbours": eight.ravel().tolist(),
        },
    }
    print("caiman", caiman)
    print("phase", phase)
    with open(out, "w") as handle:
        json.dump(result, handle)


if __name__ == "__main__":
    main(sys.argv[1])
