#!/usr/bin/env python3
"""Generate upstream BrkRaw v0.5.7 NIfTI-1 reference oracles across PV5.1 and PV6.0.1 datasets.

Outputs per-scan NIfTI-1 files plus a JSON manifest of exact shapes, dtypes,
affines, scaling, slice codes, voxel checksums, and physical RAS landmark coordinates
(intensity centroid & peak voxel in mm) so parity.mjs checks BOTH voxel bytes and
physical 3D anatomy orientation (catching any mirrored or rotated specimen).
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import nibabel as nib
import numpy as np
from brkraw.apps.loader import BrukerLoader


def physical_landmarks(arr: np.ndarray, affine: np.ndarray) -> dict:
    # Collapse >3D volumes to volume 0 for 3D anatomical landmark check
    vol = arr[..., 0] if arr.ndim > 3 else arr
    while vol.ndim > 3:
        vol = vol[..., 0]
    flat_idx = int(np.argmax(vol))
    ijk_peak = np.array(np.unravel_index(flat_idx, vol.shape), dtype=float)
    xyz_peak = (affine[:3, :3] @ ijk_peak + affine[:3, 3]).tolist()

    weights = np.maximum(vol.astype(np.float64), 0.0)
    total = float(weights.sum())
    if total > 0:
        grid = np.indices(vol.shape, dtype=np.float64)
        ijk_com = np.array([(grid[a] * weights).sum() / total for a in range(3)])
    else:
        ijk_com = np.zeros(3)
    xyz_com = (affine[:3, :3] @ ijk_com + affine[:3, 3]).tolist()
    return {
        "peakIjk": [int(x) for x in ijk_peak],
        "peakXyzMm": [round(x, 6) for x in xyz_peak],
        "comIjk": [round(float(x), 6) for x in ijk_com],
        "comXyzMm": [round(x, 6) for x in xyz_com],
    }


def export_case(
    loader: BrukerLoader,
    dataset_name: str,
    zip_path: Path,
    scan_id: int,
    reco_id: int,
    out_dir: Path,
    space: str = "subject_ras",
    override_subject_type: str | None = None,
    override_subject_pose: str | None = None,
) -> list[dict]:
    nii = loader.convert(
        scan_id,
        reco_id,
        space=space,
        override_subject_type=override_subject_type,
        override_subject_pose=override_subject_pose,
    )
    imgs = nii if isinstance(nii, tuple) else (nii,)
    records = []
    for pack_idx, img in enumerate(imgs):
        assert img is not None
        tag = f"{dataset_name}_s{scan_id}_r{reco_id}_p{pack_idx}_{space}"
        if override_subject_type:
            tag += f"_{override_subject_type}"
        if override_subject_pose:
            tag += f"_{override_subject_pose}"
        out_path = out_dir / f"{tag}.nii"
        nib.save(img, str(out_path))
        hdr = img.header
        raw = np.asarray(img.dataobj)
        # Ensure little-endian Fortran order bytes hash (matches NIfTI payload bytes)
        raw_le = np.asfortranarray(raw, dtype=raw.dtype.newbyteorder("<"))
        payload_sha256 = hashlib.sha256(raw_le.tobytes(order="F")).hexdigest()
        records.append(
            {
                "id": tag,
                "dataset": dataset_name,
                "zipPath": str(zip_path),
                "oracleNii": str(out_path),
                "scanId": scan_id,
                "recoId": reco_id,
                "slicePackIndex": pack_idx,
                "space": space,
                "overrideSubjectType": override_subject_type,
                "overrideSubjectPose": override_subject_pose,
                "shape": list(raw.shape),
                "dtype": str(hdr.get_data_dtype()),
                "sclSlope": float(hdr["scl_slope"]),
                "sclInter": float(hdr["scl_inter"]),
                "qformCode": int(hdr["qform_code"]),
                "sformCode": int(hdr["sform_code"]),
                "sliceCode": int(hdr["slice_code"]),
                "xyztUnits": int(hdr["xyzt_units"]),
                "pixdim": [float(x) for x in hdr["pixdim"][:5]],
                "affine": [[float(v) for v in row] for row in img.affine],
                "payloadSha256": payload_sha256,
                "landmarks": physical_landmarks(raw, img.affine),
            }
        )
    return records


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pv6-zip", type=Path, required=True)
    parser.add_argument("--pv5-zip", type=Path, required=True)
    parser.add_argument("--out-dir", type=Path, required=True)
    args = parser.parse_args()

    args.out_dir.mkdir(parents=True, exist_ok=True)
    cases: list[dict] = []

    pv6 = BrukerLoader(args.pv6_zip)
    for sid in [3, 6, 7, 10, 11]:
        cases.extend(export_case(pv6, "pv6", args.pv6_zip, sid, 1, args.out_dir))
    # Extra coordinate spaces & subject-pose override checks on PV6 scan 6
    cases.extend(export_case(pv6, "pv6", args.pv6_zip, 6, 1, args.out_dir, space="scanner"))
    cases.extend(export_case(pv6, "pv6", args.pv6_zip, 6, 1, args.out_dir, space="raw"))
    cases.extend(
        export_case(
            pv6,
            "pv6",
            args.pv6_zip,
            6,
            1,
            args.out_dir,
            space="subject_ras",
            override_subject_type="Biped",
            override_subject_pose="Head_Prone",
        )
    )

    pv5 = BrukerLoader(args.pv5_zip)
    # Scans 3 (3-pack TriPilot), 4 (3D 2-echo FieldMap), 9 (3D coronal whole-brain rat TurboRARE)
    for sid in [3, 4, 9]:
        cases.extend(export_case(pv5, "pv5", args.pv5_zip, sid, 1, args.out_dir))
    # Extra pose override on PV5.1 rat 3D anatomy scan 9 (subject_type=None -> Biped fallback vs Quadruped override)
    cases.extend(
        export_case(
            pv5,
            "pv5",
            args.pv5_zip,
            9,
            1,
            args.out_dir,
            space="subject_ras",
            override_subject_type="Quadruped",
            override_subject_pose="Head_Prone",
        )
    )

    manifest_path = args.out_dir / "oracles.json"
    manifest_path.write_text(json.dumps(cases, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {len(cases)} upstream BrkRaw 0.5.7 oracle cases to {manifest_path}")


if __name__ == "__main__":
    main()
