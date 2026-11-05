"""CaImAn rigid motion-correction reference for the calcium-imaging example.

CaImAn (GPL-2) is an external validation reference only: no code from it is in the app.
Both CaImAn and the app register every frame to the same initial template, the median of
the means of consecutive 10-frame bins, so the comparison isolates the shift estimator.

    python -I caiman_reference.py <example.ome.tif> <out.json>

Run with CaImAn at flatironinstitute/CaImAn@240e1f2 (pip install of the git checkout,
Python 3.11); `validation/README.md` records the environment and the results.
"""
import json
import sys

import numpy as np
import tifffile
from caiman.motion_correction import register_translation
from skimage.registration import phase_cross_correlation


def initial_template(movie, bin_frames=10):
    bins = movie.shape[0] // bin_frames
    means = movie[: bins * bin_frames].reshape(bins, bin_frames, *movie.shape[1:]).mean(axis=1)
    return np.median(means, axis=0)


def main(path, out):
    movie = tifffile.imread(path).astype(np.float64)
    template = initial_template(movie)
    max_shift = 10
    upsample = 10
    caiman = []
    skimage_phase = []
    for frame in movie:
        shift, _, _ = register_translation(
            template, frame, upsample_factor=upsample,
            shifts_lb=(-max_shift, -max_shift), shifts_ub=(max_shift, max_shift), max_shifts=(max_shift, max_shift))
        caiman.append([float(shift[0]), float(shift[1])])
        phase, _, _ = phase_cross_correlation(template, frame, upsample_factor=upsample, normalization="phase")
        skimage_phase.append([float(phase[0]), float(phase[1])])
    caiman = np.array(caiman)
    skimage_phase = np.array(skimage_phase)
    result = {
        "example": path.split("/")[-1],
        "template": "median over 10-frame bin means",
        "maxShift": max_shift,
        "upsample": upsample,
        "convention": "[dy, dx] applied to the frame to register it to the template",
        "templateChecksum": float(template.sum()),
        "caimanRegisterTranslation": [[round(v, 4) for v in row] for row in caiman.tolist()],
        "skimagePhaseCrossCorrelation": [[round(v, 4) for v in row] for row in skimage_phase.tolist()],
    }
    print("frames", len(caiman), "caiman range", caiman.min(0), caiman.max(0))
    print("mean |caiman - skimage phase|", np.abs(caiman - skimage_phase).mean(0), "max", np.abs(caiman - skimage_phase).max(0))
    with open(out, "w") as handle:
        json.dump(result, handle, indent=1)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
