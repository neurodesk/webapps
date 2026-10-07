#!/usr/bin/env python3
"""Compare production-browser TopoFit files with pinned OpenRecon output."""

import argparse
import hashlib
import json
import sys
from pathlib import Path

import nibabel as nib
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from thresholds import SURFACES, THRESHOLDS, within_thresholds

OUTPUTS = (*SURFACES, "topofit_qc.nii", "topofit_manifest.json")
BASELINE_OUTPUTS = (*SURFACES, "lh.mid.white", "rh.mid.white", "topofit_qc.nii")
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
        "outputSha256": {
            "lh.white": "edaa09a917052bc7d13df7e56ca849ccc0929fe789e98ab6f1bb3f83f8e66b1a",
            "rh.white": "a63cbd282ddc27fff7aadb2843c70228cba8161711c2afefa6d6b7c5080e6e53",
            "lh.pial": "91816561706d4d2fe9a29b4f4c2adaaed227dffdd936d9f9eeb2cf20b45e70ee",
            "rh.pial": "118b6d4d48ded7c6b5161d2bbd8de64d80daa5204f8bcb3f2cc98675ea5d9d6c",
            "lh.registration": "c314d6df6983d26a98a5ad58963061532679004e98f4f960c5edefeb8dc53683",
            "rh.registration": "2a45dbf37f60567e7639325523405678d23e3804c197cf4989971a62aab2c928",
            "lh.mid.white": "56584519a16c03c90c3c5ba13020e6d8e95be2a1936b26b5d0cdc9fe9c57c920",
            "rh.mid.white": "92bdeb061834015a18a75e2d5a492af00983d49dffe2008f2f536eccf367296e",
            "topofit_qc.nii": "0a7a1e0c8865e7e9ba40a10b21dd884d08ac64688462ec6f1e040b6944d8944c",
        },
        "referenceGeometrySha256": {
            "lh.white": "5e784e0bfea4a38331fd38f7f5c0f2e8804cf3a20a2a0a9019b26bec250a3119",
            "rh.white": "4a7db0d2d823112d06a28aec65532108a3d3082e0412743af48baf8feaa9c567",
            "lh.pial": "c03a1f48402e0d9ea0f916a1818a828e1e956e41fdcae1c9577aa52445f85233",
            "rh.pial": "7f7a02a203e90157df42c810df5779f22f01f9882664da6f3e8224df95cc2ae8",
            "lh.registration": "1c43ab102dac484c7ea8f8628846100ccd44901e11669932f181f7b181ace35d",
            "rh.registration": "6ea338798b366166cb95e1481b209015c98d4662fd0edf8bda339e95476d5192",
        },
    },
    "controlled": {
        "dataset": "Browser-resampled 1 mm RAS derivative of OpenNeuro ds000001/sub-01/anat/sub-01_T1w.nii.gz",
        "sha256": "69dc5c8be1850422e30ce8b03c6b434bb919c0427a3ec79e79b7552b4c00db5e",
        "preprocessing": "Both implementations receive the identical browser-resampled 1 mm RAS volume; OpenRecon runs with --no-conform.",
        "inferenceSha256": "37bea74e762cac21e75472cc7286e716c9cb85ea9745706a5513dd8876351f76",
        "alignmentInputSha256": "ad51ec5409a8be0b60ef359760fb94a76c6b788f9c628a572185daf41c92c8a0",
        "modelInputSha256": "7704182dbae55b4f103eb8fecb70ad251722e427db7b49528d82f3609589a407",
        "assetSetSha256": "80274962e92442a88f7e8c8ebddc98a01bd618e5c95070b881d12d38094db9f7",
        "outputSha256": {
            "lh.white": "d3e143eec325cf7d1a77f9b80b989190f6c0bff52c1f030e35d3d5f5fa81b050",
            "rh.white": "685d3fd77a744d1192bbdd840660feeafc083a5acb7fcfd8cdc4a87e40cde5a1",
            "lh.pial": "0d9441f7d2363589d545e9f68b0bcbbf4eeb0cd2f0337882b694e02f25d1c423",
            "rh.pial": "1322105fe9b5dc440c008859946d145f77a2679d578830081fe92cb6ad74ddc1",
            "lh.registration": "e2a577c95aaa82be66916731867bd73ef34f5fabd1d552f0c0c84bbee83a9879",
            "rh.registration": "6609d760d9faaf7d9646cfb4faf0dba02e808fa7ef121997cc467e36be311d45",
            "lh.mid.white": "6229d9a827d205ef917c7ed5dac4d328ba1acf2f5e682e7a833f2d164a5a6055",
            "rh.mid.white": "4d16ccd384079487703479338d094d708d5f508a2c6c75ea62bb5b51869d4851",
            "topofit_qc.nii": "c90587a7cfd596c80f041c86c8d257a2d2e6d146095d0fac8149cada6296807b",
        },
        "referenceGeometrySha256": {
            "lh.white": "d4baad113211b6e220e3a53ba44337aa199b9638a50fa7838935b8ecfab18acd",
            "rh.white": "b977b0a87aac9ecc1c9b49a6dead7f26dce5fb743cbcdeb36974bfda667f7294",
            "lh.pial": "459e47afd7267b2e16a5d7d5f3a08d50b40f3dc92d208bb1bb33b11d0b13721a",
            "rh.pial": "5030428d0b2becc0ba6414e308dad3f787ace0690004159981db4a68a2b2ab16",
            "lh.registration": "04b13f7308e688247036f39635d552e71d0a6f254e67fd1f44f2944488689e77",
            "rh.registration": "e3966f099af6c4e79846021a783312e443ce3b1e7be764fc69a6eed7952a7f15",
        },
    },
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


def geometry_sha256(path):
    # OpenRecon stamps each surface with its creation time, so file bytes never repeat.
    vertices, faces = nib.freesurfer.read_geometry(path)
    return hashlib.sha256(vertices.astype("<f8").tobytes() + faces.astype("<i4").tobytes()).hexdigest()


def compare_baseline(directory, pinned):
    actual = {name: sha256(directory / name) for name in BASELINE_OUTPUTS}
    changed = sorted(name for name in BASELINE_OUTPUTS if actual[name] != pinned[name])
    return {"byteIdentical": not changed, "changed": changed, "outputSha256": actual}


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
    assert manifest["runtime"]["threads"] == 2
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


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("reference", type=Path)
    parser.add_argument("browser", type=Path)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--conversion-report", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--mode", choices=tuple(INPUTS), required=True)
    parser.add_argument("--repeat", type=Path, action="append", required=True, help="a second run of the same build; required so one run cannot pass alone")
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
        reference_geometry = geometry_sha256(args.reference / "surf" / name)
        assert reference_geometry == fixture["referenceGeometrySha256"][name], f"Reference is not pinned OpenRecon output: {name}"
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
    report["baseline"] = compare_baseline(args.browser, fixture["outputSha256"])
    within = within_thresholds(report)
    identical = report["baseline"]["byteIdentical"]
    report["status"] = "passed" if within and identical else "measured-difference" if not within else "baseline-changed"
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))
    if not within:
        raise SystemExit(f"{args.mode.capitalize()} ONNX/browser parity exceeded its release thresholds")
    if not identical:
        raise SystemExit(f"{args.mode.capitalize()} outputs differ from the pinned production baseline: {', '.join(report['baseline']['changed'])}")


if __name__ == "__main__":
    main()
