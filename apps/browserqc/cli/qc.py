#!/usr/bin/env python3
"""BrowserQC without a browser: the page's pipeline on the native executables, which
must be on PATH (or in $BROWSERQC_BIN). Standard library only, Python 3.8+.
  brainchop-<model>, brainchop-mindgrab  https://github.com/neuroneural/brainchopC/releases
  niimath            https://pypi.org/project/niimath/  (--qc --pve --mask: newer than v1.0.20260926)

  python3 cli/qc.py --in T1.nii[.gz] --out qc.json [--model mindmap-pve|16chan18cls|mindmap|mindsnap] [--bids sidecar.json]
"""
import argparse
import hashlib
import urllib.request
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MODELS = json.loads((ROOT / "src" / "models.json").read_text())
TEMPLATE_URL = "https://huggingface.co/datasets/neurodeskorg/webapps/resolve/12eb1069c34097b7c0881b22e1f7e4ed953aa5cc/browserqc/avg152T1.nii.gz"
TEMPLATE_SHA256 = "e8f5440f0dcec1a4d44384acbdf19c8e6cf94c032c3356ef91c4441fee3aaea8"


def resolve_template():
    cache = Path(os.environ.get("BROWSERQC_CACHE", Path.home() / ".cache" / "browserqc")) / TEMPLATE_SHA256
    target = cache / "avg152T1.nii.gz"
    if target.exists() and hashlib.sha256(target.read_bytes()).hexdigest() == TEMPLATE_SHA256:
        return target
    cache.mkdir(parents=True, exist_ok=True)
    with urllib.request.urlopen(TEMPLATE_URL, timeout=60) as response:
        data = response.read()
    if hashlib.sha256(data).hexdigest() != TEMPLATE_SHA256:
        raise RuntimeError("Air template checksum mismatch")
    with tempfile.NamedTemporaryFile(dir=cache, delete=False) as staged:
        staged.write(data)
        temporary = Path(staged.name)
    temporary.replace(target)
    return target


def run(exe, *args, path):
    found = shutil.which(exe, path=path)
    if not found:
        raise RuntimeError(f"{exe} not found: put it on PATH or in $BROWSERQC_BIN")
    if subprocess.run([found, *map(str, args)], stdout=subprocess.DEVNULL).returncode:
        raise RuntimeError(f"{exe} failed")


def main():
    parser = argparse.ArgumentParser(description="MRIQC-style QC of a T1 image with brainchop + niimath.")
    parser.add_argument("--in", dest="input", required=True, help="T1.nii[.gz]")
    parser.add_argument("--out", required=True, help="report JSON")
    parser.add_argument("--model", default="mindmap-pve", choices=list(MODELS))  # closest to MRIQC
    parser.add_argument("--bids", help="BIDS sidecar to embed as bids_meta")
    parser.add_argument("--template", type=Path, help="Explicit alternative air template, otherwise use the checksummed pinned template")
    args = parser.parse_args()
    path = os.pathsep.join(filter(None, [os.environ.get("BROWSERQC_BIN"), os.environ.get("PATH")]))
    model = MODELS[args.model]
    t1 = os.path.abspath(args.input)  # a leading '-' must not read as an option
    with tempfile.TemporaryDirectory(prefix="browserqc-", dir=os.environ.get("TMPDIR")) as tmp:
        tmp = Path(tmp)
        # MRIQC segments inside SynthStrip's brain+CSF mask; mindgrab's is its match, and niimath
        # counts mask voxels that are neither GM nor WM as CSF (the extra-cerebral CSF).
        run("brainchop-mindgrab", t1, "--mask", tmp / "mask.nii", "-o", tmp / "brain.nii", path=path)
        if model.get("pve"):
            run(f"brainchop-{model['pve']}", t1, "--pve", "-o", tmp / "pve.nii", path=path)  # writes pve_{gm,wm,csf}.nii
            tissues = ["--pve", *(tmp / f"pve_{t}.nii" for t in ("csf", "gm", "wm"))]
        else:
            run(f"brainchop-{args.model}", t1, "-o", tmp / "seg.nii", path=path)
            tissues = ["--seg", tmp / "seg.nii", "--csf", ",".join(map(str, model["csf"])),
                       "--wm", ",".join(map(str, model["wm"]))]
        template = args.template if args.template else resolve_template()
        run("niimath", "--qc", t1, *tissues, "--mask", tmp / "mask.nii", "--air", template, "--json", tmp / "qc.json", path=path)
        report = json.loads((tmp / "qc.json").read_text())
    # Match the page's report: its provenance and bids_meta, and the template's bare name.
    report["provenance"]["air_template"] = template.name
    report["provenance"]["segmentation"] = f"brainchop {args.model} ({model['label']})"
    if args.bids:
        report["bids_meta"] = json.loads(Path(args.bids).read_text())
    Path(args.out).write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError, ValueError) as err:  # ValueError: a malformed --bids sidecar
        sys.exit(f"error: {err}")
