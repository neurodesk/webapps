#!/usr/bin/env python3
"""Compare production-browser TopoFit files with pinned OpenRecon output."""

import argparse
import hashlib
import json
from pathlib import Path

import nibabel as nib
import numpy as np


SURFACES = (
    "lh.white",
    "rh.white",
    "lh.pial",
    "rh.pial",
    "lh.registration",
    "rh.registration",
)
OUTPUTS = (*SURFACES, "topofit_qc.nii", "topofit_manifest.json")
CONTAINER = "vnmd/topofit_0.5.1@sha256:dff22ad5577a1a7ba0530759e009f293271ea5ddfc3441fb35b61322bbd6ec29"
RELEASE = "topofit-0.5.1-onnx-20260911"
INPUTS = {
    "end-to-end": {
        "dataset": "OpenNeuro ds000001/sub-01/anat/sub-01_T1w.nii.gz",
        "sha256": "bdb7022ae229c5b8edd16425928c9243c562f84082b9b8e6f97cdba8b9354a98",
        "preprocessing": "Both implementations conform the original anisotropic scan with the pinned OpenRecon cubic contract.",
        "inferenceSha256": "63cb6de32f0ef41ee536c4d98bd826c0be82b7a3999ab50a3600562d5a802381",
        "alignmentInputSha256": "dfe7f91f20904694784aece9f38c6a6e548806154ebb414ac0f00e01fdcb478e",
        "modelInputSha256": "01c640f9a27e12c8b0dacf3ca8c2d988e238403f7089a8de466db9c05c559ac3",
        "assetSetSha256": "80274962e92442a88f7e8c8ebddc98a01bd618e5c95070b881d12d38094db9f7",
    },
    "controlled": {
        "dataset": "Browser-resampled 1 mm RAS derivative of OpenNeuro ds000001/sub-01/anat/sub-01_T1w.nii.gz",
        "sha256": "69dc5c8be1850422e30ce8b03c6b434bb919c0427a3ec79e79b7552b4c00db5e",
        "preprocessing": "Both implementations receive the identical browser-resampled 1 mm RAS volume; OpenRecon runs with --no-conform.",
        "inferenceSha256": "37bea74e762cac21e75472cc7286e716c9cb85ea9745706a5513dd8876351f76",
        "alignmentInputSha256": "ad51ec5409a8be0b60ef359760fb94a76c6b788f9c628a572185daf41c92c8a0",
        "modelInputSha256": "7704182dbae55b4f103eb8fecb70ad251722e427db7b49528d82f3609589a407",
        "assetSetSha256": "80274962e92442a88f7e8c8ebddc98a01bd618e5c95070b881d12d38094db9f7",
    },
}
THRESHOLDS = {
    "surfaceMeanMm": 0.25,
    "surfaceP95Mm": 0.5,
    "surfaceMaxMm": 2.0,
    "registrationMeanDegrees": 0.1,
    "registrationP95Degrees": 0.25,
    "registrationRadiusMaxMm": 0.01,
    "qcWithinOneVoxel": 0.99,
}


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def canonical_sha256(value):
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(encoded).hexdigest()


def percentile(values, probability):
    return float(np.quantile(values, probability, method="linear"))


def compare_surface(reference, browser, registration):
    reference_vertices, reference_faces = nib.freesurfer.read_geometry(reference)
    browser_vertices, browser_faces = nib.freesurfer.read_geometry(browser)
    assert reference_vertices.shape == (245762, 3)
    assert browser_vertices.shape == reference_vertices.shape
    assert reference_faces.shape == (491520, 3)
    assert np.array_equal(browser_faces, reference_faces)
    assert np.isfinite(browser_vertices).all()
    delta = np.linalg.norm(browser_vertices - reference_vertices, axis=1)
    result = {
        "vertices": int(browser_vertices.shape[0]),
        "faces": int(browser_faces.shape[0]),
        "faces_identical": True,
        "mean_corresponding_distance_mm": float(delta.mean(dtype=np.float64)),
        "p95_corresponding_distance_mm": percentile(delta, 0.95),
        "max_corresponding_distance_mm": float(delta.max()),
        "browser_sha256": sha256(browser),
        "reference_sha256": sha256(reference),
    }
    if registration:
        reference_radius = np.linalg.norm(reference_vertices, axis=1)
        browser_radius = np.linalg.norm(browser_vertices, axis=1)
        cosine = np.sum(reference_vertices * browser_vertices, axis=1)
        cosine /= reference_radius * browser_radius
        angle = np.degrees(np.arccos(np.clip(cosine, -1.0, 1.0)))
        result["mean_angular_error_degrees"] = float(angle.mean(dtype=np.float64))
        result["p95_angular_error_degrees"] = percentile(angle, 0.95)
        result["max_radius_error_mm"] = float(np.abs(browser_radius - 100.0).max())
    return result


def dice(left, right):
    denominator = np.count_nonzero(left) + np.count_nonzero(right)
    return float(2 * np.count_nonzero(left & right) / denominator) if denominator else 1.0


def dilate_one_voxel(mask):
    output = mask.copy()
    for axis in range(3):
        lower = [slice(None)] * 3
        upper = [slice(None)] * 3
        lower[axis] = slice(1, None)
        upper[axis] = slice(None, -1)
        output[tuple(lower)] |= mask[tuple(upper)]
        output[tuple(upper)] |= mask[tuple(lower)]
    return output


def symmetric_coverage(left, right):
    left_count = np.count_nonzero(left)
    right_count = np.count_nonzero(right)
    if not left_count and not right_count:
        return 1.0
    if not left_count or not right_count:
        return 0.0
    left_covered = np.count_nonzero(left & dilate_one_voxel(right)) / left_count
    right_covered = np.count_nonzero(right & dilate_one_voxel(left)) / right_count
    return float(min(left_covered, right_covered))


def compare_qc(reference, browser):
    reference_image = nib.load(reference)
    browser_image = nib.load(browser)
    assert browser_image.shape == reference_image.shape
    affine_error = float(np.max(np.abs(browser_image.affine - reference_image.affine)))
    assert affine_error <= 1e-5
    reference_data = np.asarray(reference_image.dataobj)
    browser_data = np.asarray(browser_image.dataobj)
    reference_white = reference_data == 4095
    browser_white = browser_data == 4095
    reference_pial = reference_data == 3500
    browser_pial = browser_data == 3500
    result = {
        "shape": list(browser_image.shape),
        "max_affine_difference_mm": affine_error,
        "white_dice": dice(reference_white, browser_white),
        "pial_dice": dice(reference_pial, browser_pial),
        "white_within_one_voxel_symmetric_coverage": symmetric_coverage(reference_white, browser_white),
        "pial_within_one_voxel_symmetric_coverage": symmetric_coverage(reference_pial, browser_pial),
        "browser_sha256": sha256(browser),
        "reference_sha256": sha256(reference),
    }
    return result


def validate_manifest(directory, fixture):
    path = directory / "topofit_manifest.json"
    manifest = json.loads(path.read_text())
    assert manifest["schemaVersion"] == 2
    assert manifest["inputSha256"] == fixture["sha256"]
    for name in ("inferenceSha256", "alignmentInputSha256", "modelInputSha256"):
        assert manifest[name] == fixture[name]
    asset_set_sha256 = canonical_sha256(manifest["runtime"]["assets"])
    assert asset_set_sha256 == fixture["assetSetSha256"]
    assert manifest["runtime"]["release"] == RELEASE
    assert manifest["runtime"]["inference"] == "ONNX Runtime Web WASM"
    assert manifest["runtime"]["onnxruntime"] == "1.29.0"
    assert manifest["runtime"]["threads"] == 1
    assert manifest["runtime"]["graphOptimizationLevel"] == "all"
    for name in (*SURFACES, "topofit_qc.nii"):
        assert manifest["outputSha256"][name] == sha256(directory / name)
    return {
        "sha256": sha256(path),
        "inputSha256": manifest["inputSha256"],
        "inferenceSha256": manifest["inferenceSha256"],
        "alignmentInputSha256": manifest["alignmentInputSha256"],
        "modelInputSha256": manifest["modelInputSha256"],
        "runtime": {key: value for key, value in manifest["runtime"].items() if key != "assets"},
        "assetSetSha256": asset_set_sha256,
        "outputSha256": manifest["outputSha256"],
    }


def compare_repeat(directory, repeats):
    result = []
    for repeat in repeats:
        hashes = {}
        for name in OUTPUTS:
            expected = sha256(directory / name)
            actual = sha256(repeat / name)
            hashes[name] = actual
            assert actual == expected, f"Repeat output differs: {name}"
        result.append({
            "run": repeat.name,
            "byteIdentical": True,
            "outputSetSha256": canonical_sha256(hashes),
        })
    return result


def within_thresholds(report):
    for name, surface in report["surfaces"].items():
        if name.endswith("registration"):
            if surface["mean_angular_error_degrees"] > THRESHOLDS["registrationMeanDegrees"]:
                return False
            if surface["p95_angular_error_degrees"] > THRESHOLDS["registrationP95Degrees"]:
                return False
            if surface["max_radius_error_mm"] > THRESHOLDS["registrationRadiusMaxMm"]:
                return False
        else:
            if surface["mean_corresponding_distance_mm"] > THRESHOLDS["surfaceMeanMm"]:
                return False
            if surface["p95_corresponding_distance_mm"] > THRESHOLDS["surfaceP95Mm"]:
                return False
            if surface["max_corresponding_distance_mm"] > THRESHOLDS["surfaceMaxMm"]:
                return False
    return (
        report["qc"]["white_within_one_voxel_symmetric_coverage"] >= THRESHOLDS["qcWithinOneVoxel"]
        and report["qc"]["pial_within_one_voxel_symmetric_coverage"] >= THRESHOLDS["qcWithinOneVoxel"]
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("reference", type=Path)
    parser.add_argument("browser", type=Path)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--conversion-report", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--mode", choices=tuple(INPUTS), required=True)
    parser.add_argument("--repeat", type=Path, action="append", default=[])
    args = parser.parse_args()
    fixture = INPUTS[args.mode]
    assert sha256(args.input) == fixture["sha256"]
    conversion = json.loads(args.conversion_report.read_text())
    assert conversion["status"] == "onnx-cpu-parity-passed"
    report = {
        "schemaVersion": 1,
        "release": RELEASE,
        "conversionReportSha256": sha256(args.conversion_report),
        "status": "pending",
        "mode": args.mode,
        "scope": "One OpenNeuro ds000001 T1-weighted scan; engineering parity, not clinical validation.",
        "input": {
            "dataset": fixture["dataset"],
            "sha256": fixture["sha256"],
        },
        "preprocessing": fixture["preprocessing"],
        "container": CONTAINER,
        "thresholds": THRESHOLDS,
        "surfaces": {},
    }
    for name in SURFACES:
        report["surfaces"][name] = compare_surface(
            args.reference / "surf" / name,
            args.browser / name,
            name.endswith("registration"),
        )
    report["qc"] = compare_qc(
        args.reference / "topofit_qc.nii.gz",
        args.browser / "topofit_qc.nii",
    )
    report["provenance"] = validate_manifest(args.browser, fixture)
    report["repeatability"] = compare_repeat(args.browser, args.repeat)
    passed = within_thresholds(report)
    report["status"] = "passed" if passed else "measured-difference"
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))
    if not passed:
        raise SystemExit(f"{args.mode.capitalize()} ONNX/browser parity exceeded its release thresholds")


if __name__ == "__main__":
    main()
