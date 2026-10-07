"""Convert the pinned Osprey PRESS example with spec2nii 0.8.12.

Install spec2nii==0.8.12 and nibabel==5.4.2 in a scratch virtual environment.
Run this script with an output directory outside the source repository.
"""

import argparse
import gzip
import hashlib
import importlib.metadata
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import urllib.request

import nibabel as nib


SOURCE_REVISION = "06722850204dad69d8c0b57dc16272570df984bc"
SOURCE_URL = (
    "https://huggingface.co/datasets/neurodeskorg/webapps/resolve/"
    f"{SOURCE_REVISION}/lcmodel/examples/philips-press-group/"
)
SOURCE_CHECKSUMS = {
    "sub-01_PRESS_35_act.sdat": "fd14521b8b7e9f1fa4d1fd8930e6e4b7a4e26d535f71eab9e922d4a40c7759b0",
    "sub-01_PRESS_35_act.spar": "78b78cb9ec4d5b509563384629390702cc2caf1cc133df529beb56e4d7ae1f4f",
    "sub-01_PRESS_35_ref.sdat": "996ddb02f55c4bb65204e92f25d5a112dd72b300659a13d0aacb28040af3b59d",
    "sub-01_PRESS_35_ref.spar": "7cf63c7064d481a9330ef25b42bf012b605e62936428de5b2eed4e3438eceb34",
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    if importlib.metadata.version("spec2nii") != "0.8.12":
        raise SystemExit("Use spec2nii==0.8.12")
    if importlib.metadata.version("nibabel") != "5.4.2":
        raise SystemExit("Use nibabel==5.4.2")
    args.output.mkdir(parents=True, exist_ok=True)
    checksums = {}
    with tempfile.TemporaryDirectory(prefix="lcmodel-nifti-mrs-") as scratch:
        scratch = Path(scratch)
        for kind in ("act", "ref"):
            stem = f"sub-01_PRESS_35_{kind}"
            for extension in ("sdat", "spar"):
                name = f"{stem}.{extension}"
                urllib.request.urlretrieve(SOURCE_URL + name, scratch / name)
                checksums[name] = hashlib.sha256((scratch / name).read_bytes()).hexdigest()
                if checksums[name] != SOURCE_CHECKSUMS[name]:
                    raise ValueError(f"Source checksum mismatch: {name}")
            subprocess.run([
                shutil.which("spec2nii"), "philips", str(scratch / f"{stem}.sdat"),
                str(scratch / f"{stem}.spar"), "--anon", "-f", stem, "-o", str(scratch),
            ], check=True)
            image = nib.load(scratch / f"{stem}.nii.gz")
            metadata = json.loads(image.header.extensions[0].get_content())
            metadata.pop("ConversionTime", None)
            if metadata.get("ProtocolName") != "PRESS PAR 35":
                raise ValueError("Unexpected source sequence")
            metadata["SequenceName"] = "PRESS"
            if any(key.startswith("Patient") and key != "PatientPosition" for key in metadata):
                raise ValueError("Unexpected identifying patient metadata")
            image.header.extensions.clear()
            image.header.extensions.append(nib.nifti1.Nifti1Extension(
                44, json.dumps(metadata).encode("utf-8"),
            ))
            output_stem = "sub-01_PRESS_35" if kind == "act" else "sub-01_PRESS_35_water"
            output = args.output / f"{output_stem}.nii.gz"
            output.write_bytes(gzip.compress(image.to_bytes(), compresslevel=9, mtime=0))
            checksums[output.name] = hashlib.sha256(output.read_bytes()).hexdigest()
    (args.output / "checksums.json").write_text(json.dumps(checksums, indent=2) + "\n")


if __name__ == "__main__":
    main()
