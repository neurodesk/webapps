#!/usr/bin/env python3
"""Build CALMaR's MNI152 1 mm arterial territories atlas derivative.

Source: Liu et al. (2023), "Digital 3D Brain MRI Arterial Territories Atlas",
Scientific Data 10:74 (DOI: 10.1038/s41597-022-01923-0), NITRC project
`arterialatlas` (DOI: 10.25790/bml0cm.109), mirrored at
https://github.com/Chin-Fu-Liu/Arterial_Atlas (CC BY-SA 4.0).

Transformations applied to `data/Atlas_182/ArterialAtlas.nii`
(commit fbeb3fe70b6fb8185244d02f9c6b6e07c13235e0):
  1. Squeeze trailing singleton 4th dimension (182, 218, 182, 1) -> (182, 218, 182).
  2. Zero lateral ventricle labels 31 (left) and 32 (right) -> 0 so only the 30
     sided arterial territories (labels 1..30) are scored as labeled territories
     while ventricular lesion voxels remain in the whole-lesion denominator.
  3. Cast losslessly from int16 to uint8 (labels 0..30).
  4. Replace the MRIStudio zero-origin header `(-1,0,0,0; 0,1,0,0; 0,0,1,0)`
     with the standard FSL MNI152 1 mm affine `(-1,0,0,90; 0,1,0,-126; 0,0,1,-72)`
     on both sform (code 4) and qform (code 4).
  5. Write a deterministic gzipped NIfTI-1 file (`mtime=0`, level 9) together
     with LICENSE, NOTICE.txt, and provenance.json.

Usage:
    python3 apps/calmar/scripts/build_arterial_atlas.py --out "$TMPDIR/arterial-stage"
    python3 apps/calmar/scripts/build_arterial_atlas.py --out "$TMPDIR/arterial-stage" \\
        --url https://huggingface.co/datasets/neurodeskorg/webapps/resolve/<commit>/calmar/atlases/arterial-territories/ArterialAtlas_MNI152_1mm_30territories.nii.gz
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import io
import json
import urllib.request
from pathlib import Path

import nibabel as nib
import numpy as np

UPSTREAM_COMMIT = "fbeb3fe70b6fb8185244d02f9c6b6e07c13235e0"
UPSTREAM_REPO = "https://github.com/Chin-Fu-Liu/Arterial_Atlas"
UPSTREAM_ATLAS_URL = (
    f"https://raw.githubusercontent.com/Chin-Fu-Liu/Arterial_Atlas/{UPSTREAM_COMMIT}/"
    "data/Atlas_182/ArterialAtlas.nii"
)
UPSTREAM_ATLAS_SHA256 = "426f2c59577b4aba631b4b0e9d0c8fd27881930c754fdc46447a3847188534ba"
UPSTREAM_LICENSE_URL = (
    f"https://raw.githubusercontent.com/Chin-Fu-Liu/Arterial_Atlas/{UPSTREAM_COMMIT}/LICENSE"
)
UPSTREAM_LICENSE_SHA256 = "7abe19ec9bb73b36141b999b861d24ad855e808bafe0f81e84cce28556f6c297"

ASSET_ID = "arterial-territories-mni152-1mm"
FILENAME = "atlases/ArterialAtlas_MNI152_1mm_30territories.nii.gz"
CACHE_KEY = "arterial-territories-mni152-1mm-v1"
FSL_MNI152_1MM_AFFINE = np.array(
    [
        [-1.0, 0.0, 0.0, 90.0],
        [0.0, 1.0, 0.0, -126.0],
        [0.0, 0.0, 1.0, -72.0],
        [0.0, 0.0, 0.0, 1.0],
    ],
    dtype=np.float64,
)

# Verified against voxel centroids in RAS world coordinates (all odd IDs have
# negative mean X = Left; all even IDs have positive mean X = Right). Spelling
# and L/R acronym typos in upstream data/ArterialAtlasLables.txt are corrected.
PARCEL_LABELS: dict[str, str] = {
    "1": "Left Anterior Cerebral Artery",
    "2": "Right Anterior Cerebral Artery",
    "3": "Left Medial Lenticulostriate",
    "4": "Right Medial Lenticulostriate",
    "5": "Left Lateral Lenticulostriate",
    "6": "Right Lateral Lenticulostriate",
    "7": "Left Middle Cerebral Artery (Frontal)",
    "8": "Right Middle Cerebral Artery (Frontal)",
    "9": "Left Middle Cerebral Artery (Parietal)",
    "10": "Right Middle Cerebral Artery (Parietal)",
    "11": "Left Middle Cerebral Artery (Temporal)",
    "12": "Right Middle Cerebral Artery (Temporal)",
    "13": "Left Middle Cerebral Artery (Occipital)",
    "14": "Right Middle Cerebral Artery (Occipital)",
    "15": "Left Middle Cerebral Artery (Insular)",
    "16": "Right Middle Cerebral Artery (Insular)",
    "17": "Left Posterior Cerebral Artery (Temporal)",
    "18": "Right Posterior Cerebral Artery (Temporal)",
    "19": "Left Posterior Cerebral Artery (Occipital)",
    "20": "Right Posterior Cerebral Artery (Occipital)",
    "21": "Left Posterior Choroidal and Thalamoperforators",
    "22": "Right Posterior Choroidal and Thalamoperforators",
    "23": "Left Anterior Choroidal and Thalamoperforators",
    "24": "Right Anterior Choroidal and Thalamoperforators",
    "25": "Left Basilar",
    "26": "Right Basilar",
    "27": "Left Superior Cerebellar",
    "28": "Right Superior Cerebellar",
    "29": "Left Inferior Cerebellar",
    "30": "Right Inferior Cerebellar",
}

MAJOR_TERRITORIES: dict[str, str] = {
    "1": "Left ACA",
    "2": "Right ACA",
    "3": "Left ACA",
    "4": "Right ACA",
    "5": "Left MCA",
    "6": "Right MCA",
    "7": "Left MCA",
    "8": "Right MCA",
    "9": "Left MCA",
    "10": "Right MCA",
    "11": "Left MCA",
    "12": "Right MCA",
    "13": "Left MCA",
    "14": "Right MCA",
    "15": "Left MCA",
    "16": "Right MCA",
    "17": "Left PCA",
    "18": "Right PCA",
    "19": "Left PCA",
    "20": "Right PCA",
    "21": "Left PCA",
    "22": "Right PCA",
    "23": "Left PCA",
    "24": "Right PCA",
    "25": "Left VB",
    "26": "Right VB",
    "27": "Left VB",
    "28": "Right VB",
    "29": "Left VB",
    "30": "Right VB",
}

APP = Path(__file__).resolve().parents[1]
MANIFESTS = (
    APP / "web/models/manifest.json",
    APP.parents[1] / "packages/calmar/model.manifest.json",
)


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def fetch_verified(url: str, expected_sha256: str | None = None, local_path: Path | None = None) -> bytes:
    if local_path is not None and local_path.is_file():
        data = local_path.read_bytes()
    else:
        with urllib.request.urlopen(url, timeout=120) as response:
            data = response.read()
    digest = sha256_bytes(data)
    if expected_sha256 is not None and digest != expected_sha256:
        raise SystemExit(f"SHA-256 mismatch for {url}: got {digest}, expected {expected_sha256}")
    return data


def build_derivative(raw_nifti_bytes: bytes) -> tuple[bytes, dict[str, dict[str, object]]]:
    fh = nib.FileHolder(fileobj=io.BytesIO(raw_nifti_bytes))
    img = nib.Nifti1Image.from_file_map({"header": fh, "image": fh})
    arr = np.asanyarray(img.dataobj)
    if arr.shape == (182, 218, 182, 1):
        arr = arr[..., 0]
    if arr.shape != (182, 218, 182):
        raise SystemExit(f"Unexpected upstream shape: {arr.shape}")

    upstream_labels = sorted(int(v) for v in np.unique(arr))
    if upstream_labels != list(range(33)):
        raise SystemExit(f"Unexpected upstream labels: {upstream_labels}")

    cleaned = np.where((arr == 31) | (arr == 32), 0, arr)
    out_labels = sorted(int(v) for v in np.unique(cleaned))
    if out_labels != list(range(31)):
        raise SystemExit(f"Unexpected output labels after removing ventricles: {out_labels}")

    out_u8 = cleaned.astype(np.uint8)
    header = nib.Nifti1Header()
    header.set_data_shape(out_u8.shape)
    header.set_data_dtype(np.uint8)
    header.set_zooms((1.0, 1.0, 1.0))
    header.set_xyzt_units(xyz="mm")
    header.set_slope_inter(1.0, 0.0)
    header["cal_min"] = 0.0
    header["cal_max"] = 30.0
    header["descrip"] = b"Liu2023 Arterial Territories 30-label MNI152 1mm (CC-BY-SA-4.0)"
    header.set_sform(FSL_MNI152_1MM_AFFINE, code=4)
    header.set_qform(FSL_MNI152_1MM_AFFINE, code=4)

    out_img = nib.Nifti1Image(out_u8, FSL_MNI152_1MM_AFFINE, header)
    raw_out = out_img.to_bytes()

    # Deterministic gzip output (mtime=0) so checksums are reproducible.
    gz_buf = io.BytesIO()
    with gzip.GzipFile(filename="", mode="wb", fileobj=gz_buf, compresslevel=9, mtime=0) as gz:
        gz.write(raw_out)
    gz_bytes = gz_buf.getvalue()

    # Independent anatomical check: odd IDs = Left (mean X < 0), even IDs = Right (mean X > 0).
    stats: dict[str, dict[str, object]] = {}
    for label_id in range(1, 31):
        xs, ys, zs = np.where(out_u8 == label_id)
        mean_x = float(90.0 - xs.mean())
        mean_y = float(ys.mean() - 126.0)
        mean_z = float(zs.mean() - 72.0)
        if label_id % 2 == 1 and mean_x >= 0:
            raise SystemExit(f"Expected Left (X < 0) for odd label {label_id}, got {mean_x:.2f}")
        if label_id % 2 == 0 and mean_x <= 0:
            raise SystemExit(f"Expected Right (X > 0) for even label {label_id}, got {mean_x:.2f}")
        stats[str(label_id)] = {
            "label": PARCEL_LABELS[str(label_id)],
            "majorTerritory": MAJOR_TERRITORIES[str(label_id)],
            "voxels": int(xs.size),
            "centroidMniMm": [round(mean_x, 1), round(mean_y, 1), round(mean_z, 1)],
        }
    return gz_bytes, stats


def build_notice() -> str:
    return (
        "Digital 3D Brain MRI Arterial Territories Atlas (CALMaR MNI152 1 mm derivative)\n"
        "\n"
        "Original work:\n"
        "  Liu CF, Hsu J, Xu X, Kim G, Sheppard SM, Meier EL, Miller MI, Hillis AE, Faria AV.\n"
        "  Digital 3D Brain MRI Arterial Territories Atlas. Scientific Data. 2023;10:74.\n"
        "  https://doi.org/10.1038/s41597-022-01923-0\n"
        "  NITRC project: https://www.nitrc.org/projects/arterialatlas (DOI: 10.25790/bml0cm.109)\n"
        f"  Source repository: {UPSTREAM_REPO} (commit {UPSTREAM_COMMIT})\n"
        "  Copyright (c) 2021 The Johns Hopkins University.\n"
        "\n"
        "License:\n"
        "  Creative Commons Attribution-ShareAlike 4.0 International (CC BY-SA 4.0).\n"
        "  See LICENSE in this directory or https://creativecommons.org/licenses/by-sa/4.0/\n"
        "\n"
        "Modifications in this derivative (distributed under CC BY-SA 4.0):\n"
        "  1. Squeezed data/Atlas_182/ArterialAtlas.nii from (182, 218, 182, 1) to 3D (182, 218, 182).\n"
        "  2. Zeroed lateral ventricle labels 31 (left) and 32 (right) to 0 so direct arterial\n"
        "     territory overlap reports only the 30 sided arterial territories (labels 1..30)\n"
        "     while retaining ventricular voxels in the whole-lesion denominator.\n"
        "  3. Cast losslessly from int16 to uint8 and compressed with gzip (.nii.gz).\n"
        "  4. Replaced the MRIStudio zero-origin header (-1,0,0,0; 0,1,0,0; 0,0,1,0) with the\n"
        "     standard FSL MNI152 1 mm sform and qform (-1,0,0,90; 0,1,0,-126; 0,0,1,-72,\n"
        "     code=4), verified against JHU_MNI_SS_T1_brain and FSL MNI152_T1_1mm_brain.\n"
        "  5. Corrected spelling and L/R acronym typos in the label table and verified every\n"
        "     label's hemisphere against its RAS world-coordinate centroid.\n"
    )


def update_manifests(gz_bytes: bytes, source_url: str) -> None:
    entry = {
        "id": ASSET_ID,
        "filename": FILENAME,
        "sizeBytes": len(gz_bytes),
        "checksum": f"sha256:{sha256_bytes(gz_bytes)}",
        "cacheKey": CACHE_KEY,
        "sourceUrl": source_url,
        "sourceVersion": "Liu2023-ArterialAtlas-v2-MNI152-1mm-30territories",
        "resolutionMm": 1,
        "mniSpace": "FSLMNI152",
        "dims": [182, 218, 182],
        "originMm": [90.0, -126.0, -72.0],
        "parcelCount": 30,
        "supportStatus": "supported",
        "licence": "CC-BY-SA-4.0",
        "parcelLabels": PARCEL_LABELS,
        "networkLabels": MAJOR_TERRITORIES,
        "_comment": (
            "Digital 3D Brain MRI Arterial Territories Atlas (Liu et al., Scientific Data 2023; "
            "NITRC arterialatlas / Chin-Fu-Liu/Arterial_Atlas@fbeb3fe70b6fb8185244d02f9c6b6e07c13235e0). "
            "Level 1 30 sided arterial territories at FSL MNI152 1 mm (182x218x182 uint8), with "
            "standard FSL MNI152 sform/qform restored from the MRIStudio zero-origin header and "
            "lateral ventricle labels 31-32 zeroed so direct overlap scores only arterial territories."
        ),
    }
    option = {
        "id": "arterial",
        "displayName": "Arterial territories (Liu et al., 2023; 1 mm)",
        "overlapAtlasAssetId": ASSET_ID,
        "weightSource": "parcel",
        "colormap": "random",
    }
    for path in MANIFESTS:
        manifest = json.loads(path.read_text())
        assets = manifest["atlasAssets"]
        idx = next((i for i, item in enumerate(assets) if item["id"] == ASSET_ID), None)
        if idx is None:
            assets.append(entry)
        else:
            assets[idx] = entry
        if "atlasOptions" in manifest:
            options = manifest["atlasOptions"]
            opt_idx = next((i for i, item in enumerate(options) if item["id"] == option["id"]), None)
            if opt_idx is None:
                yeo_idx = next((i for i, item in enumerate(options) if item["id"] == "yeo7"), len(options))
                options.insert(yeo_idx, option)
            else:
                options[opt_idx] = option
        path.write_text(json.dumps(manifest, indent=2) + "\n")


def main(argv=None) -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--out", required=True, help="output directory for staged files")
    parser.add_argument("--source", help="optional local path to upstream data/Atlas_182/ArterialAtlas.nii")
    parser.add_argument("--url", help="hosted immutable URL to write into CALMaR manifests")
    args = parser.parse_args(argv)

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    raw_atlas = fetch_verified(
        UPSTREAM_ATLAS_URL,
        expected_sha256=UPSTREAM_ATLAS_SHA256,
        local_path=Path(args.source) if args.source else None,
    )
    license_bytes = fetch_verified(UPSTREAM_LICENSE_URL, expected_sha256=UPSTREAM_LICENSE_SHA256)
    license_sha = sha256_bytes(license_bytes)
    gz_bytes, stats = build_derivative(raw_atlas)

    out_name = Path(FILENAME).name
    (out_dir / out_name).write_bytes(gz_bytes)
    (out_dir / "LICENSE").write_bytes(license_bytes)
    (out_dir / "NOTICE.txt").write_text(build_notice(), encoding="utf-8")
    provenance = {
        "assetId": ASSET_ID,
        "filename": out_name,
        "sizeBytes": len(gz_bytes),
        "sha256": sha256_bytes(gz_bytes),
        "licence": "CC-BY-SA-4.0",
        "licenseSha256": license_sha,
        "citation": {
            "paper": "Liu CF, Hsu J, Xu X, et al. Digital 3D Brain MRI Arterial Territories Atlas. Scientific Data. 2023;10:74.",
            "doi": "10.1038/s41597-022-01923-0",
            "nitrc": "https://www.nitrc.org/projects/arterialatlas",
            "nitrcDoi": "10.25790/bml0cm.109",
        },
        "upstream": {
            "repository": UPSTREAM_REPO,
            "commit": UPSTREAM_COMMIT,
            "url": UPSTREAM_ATLAS_URL,
            "sha256": UPSTREAM_ATLAS_SHA256,
        },
        "transformations": [
            "squeeze (182, 218, 182, 1) -> (182, 218, 182)",
            "zero lateral ventricle labels 31 and 32 -> 0",
            "cast int16 -> uint8",
            "set FSL MNI152 1 mm sform and qform (-1,0,0,90; 0,1,0,-126; 0,0,1,-72), code=4",
            "compress with deterministic gzip (level 9, mtime=0)",
        ],
        "geometry": {
            "dims": [182, 218, 182],
            "spacingMm": [1.0, 1.0, 1.0],
            "mniSpace": "FSLMNI152",
            "affine": FSL_MNI152_1MM_AFFINE.tolist(),
        },
        "territories": stats,
    }
    (out_dir / "provenance.json").write_text(json.dumps(provenance, indent=2) + "\n", encoding="utf-8")

    print(
        f"Built {out_dir / out_name}: {len(gz_bytes)} bytes, "
        f"sha256:{provenance['sha256']} (30 territories verified)"
    )
    if args.url:
        update_manifests(gz_bytes, args.url)
        print("Updated CALMaR manifests.")


if __name__ == "__main__":
    main()
