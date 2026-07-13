#!/usr/bin/env python3
"""Build compact Yeo7 functional association profiles for the browser.

This is an offline asset builder, not part of the browser runtime. It decodes
each Yeo7 network ROI against Neurosynth v7 abstract term annotations through
NiMARE's ROIAssociationDecoder, then writes the small JSON payload consumed by
web/js/modules/function-profiles.js.

Example:
  python scripts/build_yeo7_function_profiles.py \
    --atlas web/models/_dev_cache/Yeo7_LiberalMask_2mm.nii.gz \
    --out web/models/annotations/yeo7_function_profiles.json
"""

import argparse
import hashlib
import json
import os
from pathlib import Path

import nibabel as nib
import numpy as np


NETWORK_LABELS = {
    1: "Visual",
    2: "Somatomotor",
    3: "DorsalAttention",
    4: "VentralAttention",
    5: "Limbic",
    6: "Frontoparietal",
    7: "Default",
}

DEFAULT_STOP_TERMS = {
    "activation",
    "activations",
    "analysis",
    "analyses",
    "brain",
    "cortex",
    "functional",
    "functional network",
    "fmri",
    "image",
    "images",
    "imaging",
    "left",
    "mri",
    "network",
    "networks",
    "neural",
    "right",
    "role",
    "signal",
    "study",
    "subjects",
    "task",
}


def clean_term(raw):
    term = str(raw)
    for prefix in ("Neurosynth_TFIDF__", "Neurosynth__", "TFIDF__"):
        if term.startswith(prefix):
            term = term[len(prefix):]
    return term.replace("_", " ").strip()


def is_kept_term(term, stop_terms):
    if not term:
        return False
    lowered = term.lower()
    if lowered in stop_terms:
        return False
    if len(lowered) < 3:
        return False
    if lowered.isdigit():
        return False
    return True


def import_nimare():
    try:
        from nimare.decode import discrete
        from nimare.extract import fetch_neurosynth
    except ImportError as exc:
        raise SystemExit(
            "NiMARE is required for this offline builder. Install it in a "
            "throwaway environment, for example: python -m pip install nimare"
        ) from exc
    return discrete, fetch_neurosynth


def load_studyset(data_dir):
    _, fetch_neurosynth = import_nimare()
    return fetch_neurosynth(
        data_dir=str(data_dir),
        version="7",
        source="abstract",
        vocab="terms",
        type="tfidf",
        return_type="studyset",
    )[0]


def decode_network(studyset, atlas_img, atlas_data, label, top_terms, min_score, stop_terms):
    discrete, _ = import_nimare()
    roi_data = (atlas_data == label).astype(np.int32)
    roi_img = nib.Nifti1Image(roi_data, atlas_img.affine, atlas_img.header)

    decoder = discrete.ROIAssociationDecoder(roi_img)
    decoder.fit(studyset)
    decoded = decoder.transform()
    if "r" not in decoded.columns:
        raise RuntimeError("ROIAssociationDecoder output is missing the 'r' score column")

    rows = []
    for feature, row in decoded.sort_values(by="r", ascending=False).iterrows():
        term = clean_term(feature)
        score = float(row["r"])
        if score < min_score:
            continue
        if not is_kept_term(term, stop_terms):
            continue
        rows.append({
            "term": term,
            "score": round(score, 6),
            "rank": len(rows) + 1,
        })
        if len(rows) >= top_terms:
            break
    return rows


def build_profiles(args):
    atlas_path = Path(args.atlas)
    if not atlas_path.exists():
        raise SystemExit(f"Atlas not found: {atlas_path}")

    atlas_img = nib.load(str(atlas_path))
    atlas_data = np.asarray(atlas_img.dataobj)
    stop_terms = set(DEFAULT_STOP_TERMS)
    if args.stop_terms:
        stop_terms.update(t.strip().lower() for t in args.stop_terms.split(",") if t.strip())

    studyset = load_studyset(Path(args.data_dir))
    network_profiles = {}
    for label, name in NETWORK_LABELS.items():
        print(f"Decoding {name}...")
        network_profiles[name] = decode_network(
            studyset,
            atlas_img,
            atlas_data,
            label,
            args.top_terms,
            args.min_score,
            stop_terms,
        )

    return {
        "id": "yeo7-neurosynth-v7-function-profiles",
        "source": "Neurosynth v7",
        "method": "NiMARE ROIAssociationDecoder",
        "atlasAssetId": "yeo7-2mm",
        "sourceLabel": "Neurosynth v7 via NiMARE",
        "profileSet": "neurosynth-v7",
        "description": (
            "Compact exploratory Yeo7 functional association profiles for "
            "browser-side lesion-network result interpretation."
        ),
        "networkProfiles": network_profiles,
    }


def write_json(payload, out_path):
    out_path.parent.mkdir(parents=True, exist_ok=True)
    encoded = json.dumps(payload, indent=2, sort_keys=False).encode("utf-8")
    out_path.write_bytes(encoded + b"\n")
    checksum = hashlib.sha256(out_path.read_bytes()).hexdigest()
    size = out_path.stat().st_size
    return size, checksum


def main():
    root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--atlas",
        default=str(root / "web/models/_dev_cache/Yeo7_LiberalMask_2mm.nii.gz"),
        help="Path to the supported Yeo7 2mm atlas NIfTI.",
    )
    parser.add_argument(
        "--out",
        default=str(root / "web/models/annotations/yeo7_function_profiles.json"),
        help="Output JSON path.",
    )
    parser.add_argument(
        "--data-dir",
        default=os.environ.get("NIMARE_DATA", "/tmp/lnm_nimare_data"),
        help="NiMARE/Neurosynth download cache directory.",
    )
    parser.add_argument("--top-terms", type=int, default=24)
    parser.add_argument("--min-score", type=float, default=0.05)
    parser.add_argument(
        "--stop-terms",
        default="",
        help="Comma-separated extra terms to filter after prefix cleanup.",
    )
    args = parser.parse_args()

    payload = build_profiles(args)
    size, checksum = write_json(payload, Path(args.out))
    print(f"Wrote {args.out}")
    print(f"  sizeBytes={size}")
    print(f"  checksum=sha256:{checksum}")
    print("Update web/models/manifest.json if either value changed.")


if __name__ == "__main__":
    main()
