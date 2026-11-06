"""Record NeuroM's morphometrics for SWC files as the app's independent reference.

Usage (Python 3.13, the pins in requirements.txt):

    python -m venv venv && venv/bin/pip install -r requirements.txt
    venv/bin/python neurom_reference.py --step 10 out.json file.swc [file.swc ...]

Every value is what NeuroM 4 reports for the whole morphology and for each
neurite type. Sholl uses the app's radii (step, 2 step, ... up to the largest
radial distance of any point), not NeuroM's default bins, which start at the
soma radius. Angles are in radians and sorted, so the order NeuroM visits
bifurcations in does not matter.
"""

import argparse
import hashlib
import json
import math
import platform
from importlib.metadata import version
from pathlib import Path

import neurom as nm
import numpy as np
from neurom import NeuriteType
from neurom.features import morphology as mf

TYPES = {
    "all": NeuriteType.all,
    "axon": NeuriteType.axon,
    "basal": NeuriteType.basal_dendrite,
    "apical": NeuriteType.apical_dendrite,
}


def summary(morph, neurite_type):
    get = lambda name, **kw: nm.get(name, morph, neurite_type=neurite_type, **kw)
    path = get("section_path_distances")
    branch = get("section_branch_orders")
    strahler = get("section_strahler_orders")
    local = sorted(float(a) for a in get("local_bifurcation_angles"))
    remote = sorted(float(a) for a in get("remote_bifurcation_angles"))
    return {
        "neurites": int(get("number_of_neurites")),
        "sections": int(get("number_of_sections")),
        "bifurcations": int(get("number_of_bifurcations")),
        "forkingPoints": int(get("number_of_forking_points")),
        "terminals": int(get("number_of_leaves")),
        "totalLength": float(get("total_length")),
        "surfaceArea": float(get("total_area")),
        "volume": float(get("total_volume")),
        "maxPathDistance": float(max(path)) if len(path) else 0.0,
        "maxRadialDistance": float(mf.max_radial_distance(morph, neurite_type=neurite_type)),
        "maxBranchOrder": int(max(branch)) if len(branch) else 0,
        "maxStrahlerOrder": int(max(strahler)) if len(strahler) else 0,
        "localBifurcationAngles": local,
        "remoteBifurcationAngles": remote,
    }


def sholl_radii(morph, step):
    center = morph.soma.center
    far = max(
        float(np.max(np.linalg.norm(section.points[:, :3] - center, axis=1)))
        for section in nm.iter_sections(morph)
    )
    return [step * k for k in range(1, math.floor(far / step) + 1)]


def reference(path, step):
    data = Path(path).read_bytes()
    morph = nm.load_morphology(path)
    radii = sholl_radii(morph, step)
    return {
        "file": Path(path).name,
        "sha256": hashlib.sha256(data).hexdigest(),
        "somaCenter": [float(v) for v in morph.soma.center],
        "features": {name: summary(morph, t) for name, t in TYPES.items()},
        "sholl": {
            "step": step,
            "radii": radii,
            "crossings": {
                name: [int(c) for c in mf.sholl_crossings(morph, t, morph.soma.center, radii)]
                for name, t in TYPES.items()
            },
        },
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--step", type=float, default=10.0)
    parser.add_argument("out")
    parser.add_argument("files", nargs="+")
    args = parser.parse_args()
    result = {
        "tool": {"python": platform.python_version(), "neurom": version("neurom"), "morphio": version("morphio"), "numpy": version("numpy")},
        "morphologies": [reference(path, args.step) for path in args.files],
    }
    Path(args.out).write_text(json.dumps(result, indent=1) + "\n")


if __name__ == "__main__":
    main()
