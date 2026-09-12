#!/usr/bin/env python3
"""Create the checked-in immutable asset manifest from a validated export."""

import argparse
import hashlib
import json
from pathlib import Path

from huggingface_hub import hf_hub_download


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def validate_evidence(assets, release, conversion_sha):
    statuses = {"controlled": "passed", "end-to-end": "measured-difference"}
    surface_names = ("lh.white", "rh.white", "lh.pial", "rh.pial", "lh.registration", "rh.registration")
    for mode, status in statuses.items():
        result = json.loads((assets / "validation" / "reports" / f"ds000001-{mode}.json").read_text())
        assert result["release"] == release
        assert result["conversionReportSha256"] == conversion_sha
        assert result["status"] == status
        browser = assets / "validation" / "browser" / mode
        provenance = json.loads((browser / "topofit_manifest.json").read_text())
        assert provenance["runtime"]["release"] == release
        for name in surface_names:
            assert result["surfaces"][name]["browser_sha256"] == sha256(browser / name)
        assert result["qc"]["browser_sha256"] == sha256(browser / "topofit_qc.nii")


def verify_public_release(records, directory, repository, revision, path):
    required = {record["filename"] for record in records}
    required.update({
        "conversion-report.json",
        "LICENSE",
        "NOTICE",
    })
    required.update(
        candidate.relative_to(directory).as_posix()
        for candidate in (directory / "validation").rglob("*")
        if candidate.is_file()
    )
    for filename in sorted(required):
        downloaded = Path(hf_hub_download(
            repo_id=repository,
            repo_type="dataset",
            filename=f"{path}/{filename}",
            revision=revision,
            token=False,
        ))
        assert sha256(downloaded) == sha256(directory / filename)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("assets", type=Path)
    parser.add_argument("revision")
    parser.add_argument("output", type=Path)
    parser.add_argument("--release", default="topofit-0.5.1-onnx-20260911")
    parser.add_argument("--repo", default="neurodeskorg/webapps")
    parser.add_argument("--path", default="topofit/0.5.1/onnx-20260911")
    args = parser.parse_args()
    report = json.loads((args.assets / "conversion-report.json").read_text())
    assert report["status"] == "onnx-cpu-parity-passed"
    conversion_sha = sha256(args.assets / "conversion-report.json")
    records = report["models"] + report["assets"]
    for record in records:
        path = args.assets / record["filename"]
        assert path.stat().st_size == record["bytes"]
        assert sha256(path) == record["sha256"]
    validate_evidence(args.assets, args.release, conversion_sha)
    verify_public_release(records, args.assets, args.repo, args.revision, args.path)
    manifest = {
        "schema_version": 1,
        "app": "topofit",
        "release": args.release,
        "license": "GPL-3.0-only",
        "repository": args.repo,
        "revision": args.revision,
        "base_url": (
            "https://huggingface.co/datasets/neurodeskorg/webapps/resolve/"
            f"{args.revision}/{args.path}/"
        ),
        "source": {
            **report["source"],
            "neurocontainersCommit": "1c960cec82947541d270e06099ab415933c9ea07",
            "brainnetTagObject": "a526011e1eb14e73f933d37d6d3db086b68f8474",
        },
        "preprocessing_contract": {
            "tregaShape": [192, 224, 192],
            "topofitShape": [176, 208, 176],
            "layout": "NCDHW; RAS spatial axes, z fastest",
            "normalizationQuantiles": [0.001, 0.999],
            "surfaceOrder": 6,
            "verticesPerHemisphere": 245762,
            "facesPerHemisphere": 491520,
        },
        "assets": records,
        "validation": {
            "dataset": "OpenNeuro ds000001",
            "example_url": "https://s3.amazonaws.com/openneuro.org/ds000001/sub-01/anat/sub-01_T1w.nii.gz",
            "example_sha256": "bdb7022ae229c5b8edd16425928c9243c562f84082b9b8e6f97cdba8b9354a98",
            "controlled_comparison": "packages/topofit/validation/results/ds000001-controlled.json",
            "end_to_end_comparison": "packages/topofit/validation/results/ds000001-end-to-end.json",
        },
    }
    args.output.write_text(json.dumps(manifest, indent=2) + "\n")


if __name__ == "__main__":
    main()
