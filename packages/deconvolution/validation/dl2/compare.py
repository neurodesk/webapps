"""Compare this package's RL / RL-TV with DeconvolutionLab2's on the phantom."""
import json
import sys

import numpy as np
import tifffile

SHAPE = (36, 56, 56)
INNER = (slice(6, -6), slice(7, -7), slice(7, -7))


def main(work, runs_file):
    phantom = np.fromfile(f"{work}/phantom.f64").reshape(SHAPE)
    image = np.fromfile(f"{work}/image.f64").reshape(SHAPE)
    rmse = lambda a: float(np.sqrt(((a - phantom)[INNER] ** 2).mean()))
    out = {
        "generator": "packages/deconvolution/validation/dl2/run.sh",
        "reference": "DeconvolutionLab2 (DeconvolutionLab_2.jar sha256 37ade1a1…, ImageJ 1.54p), -norm 1",
        "region": "voxels at least one PSF half-width from the border",
        "inputRmse": rmse(image),
        "runs": [],
    }
    for name, iterations, weight in json.load(open(runs_file)):
        ours = np.fromfile(f"{work}/ours_{name}.f64").reshape(SHAPE)
        theirs = tifffile.imread(f"{work}/dl2_{name}.tif").astype(float).reshape(SHAPE)
        r = float(np.corrcoef(ours[INNER].ravel(), theirs[INNER].ravel())[0, 1])
        out["runs"].append({"run": name, "iterations": iterations, "tvWeight": weight, "correlation": round(r, 4), "rmseOurs": round(rmse(ours), 3), "rmseDeconvolutionLab2": round(rmse(theirs), 3)})
    json.dump(out, sys.stdout, indent=1)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
