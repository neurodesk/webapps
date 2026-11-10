# SPDX-License-Identifier: Apache-2.0
"""Write tests/fixtures/voxels.json: 12 gate voxels of the staged toolbox reference.

Usage: python3 -I tools/fixture.py PREPARED_DIRECTORY
PREPARED_DIRECTORY is validation/prepare_reference.py's output. The voxels are evenly
spaced over the 13327 gate voxels in their C order. The signals (OpenNeuro ds005134, CC0)
and the toolbox maps (#424 reference, CC0) are copied as they are.
"""
import json
from pathlib import Path
import sys

import numpy as np

root = Path(sys.argv[1])
metadata = json.loads((root / "prepared.json").read_text())
frames = len(metadata["bvals"])
signals = np.fromfile(root / "signals.f64", "<f8").reshape(-1, frames)
expected = np.fromfile(root / "expected.f64", "<f8").reshape(-1, 4)
picks = np.linspace(0, len(signals) - 1, 12).round().astype(int)
fixture = {
    "source": metadata["source"],
    "bvals": metadata["bvals"],
    "bvecs": metadata["bvecs"],
    "voxels": [
        {
            "ijk": metadata["coordinates"][i],
            "signal": [int(v) for v in signals[i]],
            "icvf": float(expected[i, 0]),
            "isovf": float(expected[i, 1]),
            "odi": float(expected[i, 2]),
        }
        for i in picks
    ],
}
out = Path(__file__).resolve().parents[1] / "tests" / "fixtures" / "voxels.json"
out.parent.mkdir(exist_ok=True)
out.write_text(json.dumps(fixture) + "\n")
print(out)
