import json
from pathlib import Path

import nibabel as nib
import numpy as np

assert nib.__version__ == "5.2.1", nib.__version__
assert np.__version__ == "1.26.4", np.__version__

CASES = {
    "signedzero": [-0.0, 0, -0.0],
    "zero": [0, 0, 0],
    "constant": [-12.375] * 3,
    "positive": [0, 1, 1.25, 2, 100, 997.25],
    "negative": [-997.25, -100, -2, -1.25, -1, 0],
    "mixed": [-30, 0, 1, 1.1, 99],
    "large": [-3e38, 0, 3e38],
    "tiny": [-1e-30, 0, 1e-30],
    "clipping": [-2147483648, 2147483520, 4294967040],
    "half": [0, 0.5, 1, 1.5, 2, 127.5, 255],
}

fixtures = []
for datatype in (2, 4, 8, 256, 512, 768):
    for name, values in CASES.items():
        data = np.asarray(values, dtype=np.float32)
        header = nib.Nifti1Header()
        header.set_data_dtype(datatype)
        image = nib.Nifti1Image(data, np.eye(4), header.copy())
        restored = nib.Nifti1Image.from_bytes(image.to_bytes())
        expected = restored.get_fdata(dtype=np.float64).astype(np.float32)
        fixtures.append({
            "name": f"{datatype}-{name}",
            "datatype": datatype,
            "input": data.tolist(),
            "expectedBits": expected.view(np.uint32).tolist(),
            "slope": restored.dataobj.slope,
            "intercept": restored.dataobj.inter,
        })

output = Path(__file__).resolve().parents[1] / "test/fixtures/upstream-chunk-roundtrip.json"
output.write_text(json.dumps(fixtures, indent=2) + "\n")
print(f"Wrote {len(fixtures)} nibabel temporary-chunk fixtures to {output}")
