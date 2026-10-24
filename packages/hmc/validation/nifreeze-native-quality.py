"""Compare same-shell raw-mean correlations for WASM and both native precisions.

Usage: python nifreeze-native-quality.py REFERENCE WASM_OUTPUT OUTPUT_JSON
Requires nitransforms 25.1.0, nibabel, numpy, scipy and h5py. Native images are
reconstructed from pinned transforms using NiFreeze's cubic-spline resampler.
This is image QC, not a replacement for the motion acceptance gate.
"""

import hashlib
import json
import sys
from pathlib import Path

import nibabel as nb
import nitransforms
import numpy as np
import scipy
from nitransforms.io.itk import ITKLinearTransform
from nitransforms.linear import Affine
from nitransforms.resampling import apply


def main(root, output, destination):
    if nitransforms.__version__ != "25.1.0":
        raise ValueError("The reference uses nitransforms 25.1.0")
    manifest = json.loads((Path(__file__).parents[3] / "exes/dwi/hmc/validation/reference.manifest.json").read_text())
    entries = {item["path"]: item for item in manifest["files"]}

    def pinned(relative):
        path = root / relative
        data = path.read_bytes()
        expected = entries[relative]
        if len(data) != expected["bytes"] or hashlib.sha256(data).hexdigest() != expected["sha256"]:
            raise ValueError(f"Reference checksum mismatch: {relative}")
        return path

    source = nb.load(pinned("input/sub-107_dir-AP_dwi.nii.gz"))
    raw = np.asanyarray(source.dataobj)
    wasm_path = output / "sub-107_dir-AP_desc-hmc_dwi.nii.gz"
    wasm = np.asanyarray(nb.load(wasm_path).dataobj)
    if wasm.shape != raw.shape or not np.isfinite(wasm).all():
        raise ValueError("Invalid WASM corrected series")
    bvals = np.loadtxt(pinned("input/sub-107_dir-AP_dwi.bval"))
    mask = np.asanyarray(nb.load(pinned("nifreeze-gp/work/brainmask.nii.gz")).dataobj) > 0
    shells = np.unique(bvals[bvals > 50])
    means = {int(shell): raw[..., bvals == shell].mean(axis=3)[mask] for shell in shells}
    rows = []
    for volume, raw_volume in enumerate(np.flatnonzero(bvals > 50)):
        shell = int(bvals[raw_volume])
        mean = means[shell]

        def correlation(values):
            value = float(np.corrcoef(values[mask], mean)[0, 1])
            if not np.isfinite(value):
                raise ValueError("Nonfinite image correlation")
            return value

        row = {"volume": volume, "rawVolume": int(raw_volume), "shell": shell,
               "before": correlation(raw[..., raw_volume]), "wasm": correlation(wasm[..., raw_volume])}
        frame = nb.Nifti1Image(raw[..., raw_volume].astype(np.float32), source.affine)
        for name, directory in [("nativeFloat", "nifreeze-gp-float"), ("nativeDouble", "nifreeze-gp"), ("wasm", None)]:
            mat = (pinned(f"{directory}/work/ants-{volume:05}0GenericAffine.mat") if directory
                   else output / f"sub-107_dir-AP_vol-{raw_volume:04}_desc-hmc_xfm.mat")
            transform = Affine(ITKLinearTransform.from_filename(mat).to_ras(reference=frame, moving=frame), reference=frame)
            if directory:
                corrected = np.asanyarray(apply(transform, frame, order=3).dataobj)
                row[name] = correlation(corrected)
            row[f"{name}Linear"] = correlation(np.asanyarray(apply(transform, frame, order=1).dataobj))
        rows.append(row)
        if (volume + 1) % 10 == 0:
            print(f"QC {volume + 1}/90", flush=True)
    summary = {}
    for shell in shells:
        selected = [row for row in rows if row["shell"] == shell]
        summary[int(shell)] = {
            name: {"median": float(np.median([row[name] for row in selected])),
                   "dropsOver002": sum(row[name] < row["before"] - 0.02 for row in selected)}
            for name in ["before", "wasm", "nativeFloat", "nativeDouble", "wasmLinear", "nativeFloatLinear", "nativeDoubleLinear"]
        }
    report = {
        "definition": "Pearson correlation inside the pinned GP brain mask against the mean of raw same-shell volumes",
        "nativeResampling": "Pinned native transforms applied to raw float32 frames with nitransforms 25.1.0 cubic spline (order 3)",
        "linearRegistrationQc": "Separate order-1 reconstructions of all three transform sets, for comparison with the archived QC script's Linear interpolation; these are not the estimator's cubic-spline outputs",
        "versions": {"nitransforms": nitransforms.__version__, "numpy": np.__version__, "scipy": scipy.__version__, "nibabel": nb.__version__},
        "wasmImageSha256": hashlib.sha256(wasm_path.read_bytes()).hexdigest(),
        "maskVoxels": int(mask.sum()), "byShell": summary, "rows": rows,
    }
    destination.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main(*(Path(argument) for argument in sys.argv[1:]))
