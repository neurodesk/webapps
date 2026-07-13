#!/usr/bin/env python3
"""Build parcel-wise Schaefer400 functional association profiles.

This is an offline asset builder, not part of the browser runtime. It runs
NiMARE's ROIAssociationDecoder logic for each Schaefer400 parcel against
Neurosynth v7 abstract term annotations, then writes the compact JSON consumed
by web/js/modules/function-profiles.js.

The implementation computes the MKDA modeled-activation matrix once on the
Schaefer cortical mask, then averages that sparse matrix parcel-by-parcel and
correlates each parcel regressor with Neurosynth term values. This matches the
ROIAssociationDecoder method while avoiding 400 repeated kernel transforms.

Example:
  python scripts/build_schaefer400_function_profiles.py \
    --atlas /tmp/Schaefer2018_400Parcels_7Networks_order_FSLMNI152_2mm.nii.gz \
    --out web/models/annotations/schaefer400_function_profiles.json
"""

import argparse
import hashlib
import json
import os
import urllib.request
from pathlib import Path

import nibabel as nib
import numpy as np


PROFILE_ID = "schaefer400-neurosynth-v7-function-profiles"
DEFAULT_SOURCE_LABEL = "Neurosynth v7 via NiMARE (parcel-wise Schaefer ROI decode)"
DEFAULT_ATLAS_URL = (
    "https://raw.githubusercontent.com/ThomasYeoLab/CBIG/"
    "v0.14.3-Update_Yeo2011_Schaefer2018_labelname/"
    "stable_projects/brain_parcellation/Schaefer2018_LocalGlobal/"
    "Parcellations/MNI/"
    "Schaefer2018_400Parcels_7Networks_order_FSLMNI152_2mm.nii.gz"
)

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
    if "__" in term:
        term = term.split("__", 1)[1]
    return term.replace("_", " ").strip()


def clean_parcel_label(raw):
    return str(raw).replace("7Networks_LH_", "LH_").replace("7Networks_RH_", "RH_")


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


def load_json(path):
    with Path(path).open("r", encoding="utf-8") as f:
        return json.load(f)


def resolve_atlas_path(atlas_arg, cache_dir):
    atlas_path = Path(atlas_arg) if atlas_arg else None
    if atlas_path and atlas_path.exists():
        return atlas_path

    cache_dir = Path(cache_dir)
    cache_dir.mkdir(parents=True, exist_ok=True)
    out_path = cache_dir / "Schaefer2018_400Parcels_7Networks_order_FSLMNI152_2mm.nii.gz"
    if out_path.exists():
        return out_path

    print(f"Downloading Schaefer400 atlas to {out_path}...")
    urllib.request.urlretrieve(DEFAULT_ATLAS_URL, out_path)
    return out_path


def top_terms_for_parcel(features, correlations, top_terms, min_score, stop_terms):
    order = np.argsort(correlations)[::-1]
    rows = []
    for idx in order:
        score = float(correlations[idx])
        if score < min_score:
            break
        term = clean_term(features[idx])
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
    discrete, _ = import_nimare()
    from nilearn.maskers import NiftiMasker

    atlas_path = resolve_atlas_path(args.atlas, args.cache_dir)
    atlas_img = nib.load(str(atlas_path))
    atlas_data = np.asarray(atlas_img.dataobj).astype(np.int32)
    labels = sorted(int(v) for v in np.unique(atlas_data) if int(v) > 0)
    if len(labels) != 400:
        raise SystemExit(f"Expected 400 Schaefer labels in atlas, got {len(labels)}")

    manifest = load_json(args.manifest)
    schaefer = next(
        (asset for asset in manifest.get("atlasAssets", [])
         if asset.get("id") == "schaefer400-7n-2mm"),
        None,
    )
    if not schaefer:
        raise SystemExit("Manifest is missing atlas asset schaefer400-7n-2mm")
    parcel_labels = schaefer.get("parcelLabels") or {}
    network_labels = schaefer.get("networkLabels") or {}

    stop_terms = set(DEFAULT_STOP_TERMS)
    if args.stop_terms:
        stop_terms.update(t.strip().lower() for t in args.stop_terms.split(",") if t.strip())

    print("Loading Neurosynth v7 Studyset via NiMARE...")
    studyset = load_studyset(Path(args.data_dir))

    mask_img = nib.Nifti1Image((atlas_data > 0).astype(np.uint8), atlas_img.affine, atlas_img.header)
    masker = NiftiMasker(
        mask_img=mask_img,
        standardize=False,
        detrend=False,
        smoothing_fwhm=None,
        dtype="float32",
    )
    masker.fit()

    decoder = discrete.ROIAssociationDecoder(masker)
    decoder._collect_inputs(studyset, drop_invalid=True)
    decoder._preprocess_input(studyset)

    print("Computing sparse MKDA modeled-activation matrix on Schaefer cortical mask...")
    ma_maps = decoder.kernel_transformer.transform(
        decoder.inputs_["coordinates"],
        decoder.masker,
        return_type="sparse",
    )
    labels_in_mask = np.asarray(masker.transform(atlas_img)).ravel().astype(np.int32)
    feature_values = decoder.inputs_["annotations"][decoder.features_].values
    features = list(decoder.features_)

    network_profiles = {}
    parcel_to_source_network = {}
    empty_profiles = []
    for pos, label in enumerate(labels, start=1):
        parcel_key = str(label)
        parcel_name = clean_parcel_label(parcel_labels.get(parcel_key, f"Parcel {label}"))
        source_network = network_labels.get(parcel_key, "")
        parcel_voxels = np.where(labels_in_mask == label)[0]
        if parcel_voxels.size == 0:
            raise SystemExit(f"No masked voxels found for Schaefer parcel {label}")

        roi_values = np.asarray(ma_maps[:, parcel_voxels].mean(axis=1)).ravel()
        correlations = discrete.pearson(roi_values, feature_values.T)
        rows = top_terms_for_parcel(
            features,
            correlations,
            args.top_terms,
            args.min_score,
            stop_terms,
        )
        if not rows:
            empty_profiles.append(parcel_name)
        network_profiles[parcel_name] = rows
        parcel_to_source_network[parcel_name] = source_network
        if pos % 25 == 0 or pos == len(labels):
            print(f"Decoded {pos}/{len(labels)} parcels...")

    if empty_profiles:
        print(f"Warning: {len(empty_profiles)} parcels had no terms above min_score={args.min_score}")

    return {
        "id": PROFILE_ID,
        "source": "Neurosynth v7",
        "method": "NiMARE ROIAssociationDecoder",
        "atlasAssetId": "schaefer400-7n-2mm",
        "sourceLabel": DEFAULT_SOURCE_LABEL,
        "profileSet": "neurosynth-v7-schaefer400-parcel-roi",
        "description": (
            "Compact exploratory Schaefer400 functional association profiles "
            "for browser-side lesion-network result interpretation. Each "
            "Schaefer parcel was decoded as its own ROI with NiMARE's "
            "ROIAssociationDecoder against Neurosynth v7 abstract term TF-IDF "
            "annotations. Intended for exploratory interpretation only, not "
            "clinical prediction."
        ),
        "profileKey": "schaeferParcelLabel",
        "parcelProfileCount": len(network_profiles),
        "topTermsPerParcel": args.top_terms,
        "minimumSourceScore": args.min_score,
        "parcelToSourceNetwork": parcel_to_source_network,
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
        default="",
        help="Path to the supported Schaefer400 2mm atlas NIfTI. If omitted, the atlas is downloaded to --cache-dir.",
    )
    parser.add_argument(
        "--manifest",
        default=str(root / "web/models/manifest.json"),
        help="Manifest containing Schaefer parcel labels and network membership.",
    )
    parser.add_argument(
        "--out",
        default=str(root / "web/models/annotations/schaefer400_function_profiles.json"),
        help="Output Schaefer400 JSON path.",
    )
    parser.add_argument(
        "--data-dir",
        default=os.environ.get("NIMARE_DATA", "/tmp/lnm_nimare_data"),
        help="NiMARE/Neurosynth download cache directory.",
    )
    parser.add_argument(
        "--cache-dir",
        default="/tmp/lnm_schaefer400_profile_data",
        help="Cache directory for downloaded Schaefer atlas input.",
    )
    parser.add_argument("--top-terms", type=int, default=24)
    parser.add_argument("--min-score", type=float, default=0.01)
    parser.add_argument(
        "--stop-terms",
        default="",
        help="Comma-separated extra terms to filter after prefix cleanup.",
    )
    args = parser.parse_args()

    payload = build_profiles(args)
    size, checksum = write_json(payload, Path(args.out))
    print(f"Wrote {args.out}")
    print(f"  parcelProfileCount={payload['parcelProfileCount']}")
    print(f"  topTermsPerParcel={payload['topTermsPerParcel']}")
    print(f"  minimumSourceScore={payload['minimumSourceScore']}")
    print(f"  sizeBytes={size}")
    print(f"  checksum=sha256:{checksum}")
    print("Update web/models/manifest.json if either value changed.")


if __name__ == "__main__":
    main()
