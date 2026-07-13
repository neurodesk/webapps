#!/usr/bin/env python3
"""Build Schaefer400 public-development-fMRI FC assets for the browser.

Outputs:
  /tmp/lnm_schaefer400_fc/Schaefer2018_400Parcels_7Networks_order_FSLMNI152_4mm.nii.gz
  /tmp/lnm_schaefer400_fc/schaefer400_fc_pack_dev155_4mm.index.json
  /tmp/lnm_schaefer400_fc/shards/schaefer400_fc_pack_dev155_4mm_000-039.bin
  ...

The FC maps use the same public Nilearn development_fmri source as the current
Yeo7 development pack. Each Schaefer parcel is used as a seed ROI, correlated
against every brain voxel per subject, Fisher-z transformed, then reduced to a
group one-sample t-statistic map. Shards are fp16 row-major maps so the browser
can lazy-fetch only parcels touched by the lesion.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path

import nibabel as nib
import numpy as np
from nilearn import datasets
from nilearn.image import index_img, load_img, resample_to_img
from nilearn.maskers import NiftiLabelsMasker, NiftiMasker

OUT_DIR = Path("/tmp/lnm_schaefer400_fc")
SHARD_SIZE = 40
NETWORK_NAME = {
    "Vis": "Visual",
    "SomMot": "Somatomotor",
    "DorsAttn": "DorsalAttention",
    "SalVentAttn": "VentralAttention",
    "Limbic": "Limbic",
    "Cont": "Frontoparietal",
    "Default": "Default",
}


def clean_parcel_label(raw: str) -> str:
    return str(raw).replace("7Networks_LH_", "LH_").replace("7Networks_RH_", "RH_")


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def label_tables(labels):
    parcel_labels = {}
    network_labels = {}
    for i, label in enumerate(labels):
        if i == 0:
            continue
        label = label.decode() if isinstance(label, bytes) else str(label)
        parcel_labels[str(i)] = clean_parcel_label(label)
        parts = label.split("_")
        network_labels[str(i)] = NETWORK_NAME.get(parts[2] if len(parts) > 2 else "", "Unassigned")
    return parcel_labels, network_labels


def upload_to_hf(paths: list[Path], token: str | None, repo_id: str, path_in_repo: str):
    if token is None:
        token = os.environ.get("HF_TOKEN")
    if not token:
        raise SystemExit("HF upload requires HF_TOKEN env var or --hf-token.")
    try:
        from huggingface_hub import HfApi
    except ImportError as exc:
        raise SystemExit("pip install huggingface_hub") from exc
    if repo_id.startswith("datasets/"):
        repo_id = repo_id[len("datasets/"):]
    api = HfApi(token=token)
    for path in paths:
        dst = f"{path_in_repo.rstrip('/')}/{path.name}"
        print(f"Uploading {path} -> hf://datasets/{repo_id}/{dst}")
        api.upload_file(
            path_or_fileobj=str(path),
            path_in_repo=dst,
            repo_id=repo_id,
            repo_type="dataset",
            commit_message=f"Update Schaefer400 FC asset {path.name}",
        )


def main(n_subjects: int, upload: bool, hf_token: str | None, repo_id: str):
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    shard_dir = OUT_DIR / "shards"
    shard_dir.mkdir(parents=True, exist_ok=True)

    schaefer = datasets.fetch_atlas_schaefer_2018(
        n_rois=400,
        yeo_networks=7,
        resolution_mm=2,
    )
    parcel_labels, network_labels = label_tables(schaefer.labels)
    atlas2 = load_img(schaefer.maps)

    print(f"Fetching development_fmri ({n_subjects} subjects)...")
    bundle = datasets.fetch_development_fmri(n_subjects=n_subjects)
    target4 = index_img(bundle.func[0], 0)
    atlas4 = resample_to_img(
        atlas2,
        target4,
        interpolation="nearest",
        force_resample=True,
        copy_header=True,
    )
    atlas4_path = OUT_DIR / "Schaefer2018_400Parcels_7Networks_order_FSLMNI152_4mm.nii.gz"
    nib.save(atlas4, atlas4_path)
    print(f"4mm atlas: {atlas4.shape}, sha256={sha256(atlas4_path)}")

    roi_masker = NiftiLabelsMasker(labels_img=atlas4, standardize="zscore_sample", verbose=0)
    brain_masker = NiftiMasker(standardize="zscore_sample", verbose=0)
    brain_masker.fit(bundle.func[0])
    n_brain = int(np.asarray(brain_masker.mask_img_.dataobj).sum())
    print(f"Brain mask voxels: {n_brain}")

    sum_z = None
    sum_sq_z = None
    n_done = 0
    for i, func in enumerate(bundle.func):
        print(f"  subject {i + 1}/{len(bundle.func)}: {Path(func).name}")
        roi_ts = roi_masker.fit_transform(func, confounds=bundle.confounds[i])
        brain_ts = brain_masker.transform(func, confounds=bundle.confounds[i])
        t = roi_ts.shape[0]
        r = (roi_ts.T @ brain_ts) / t
        z = np.arctanh(np.clip(r, -0.999, 0.999)).astype(np.float32)
        if sum_z is None:
            sum_z = np.zeros_like(z, dtype=np.float64)
            sum_sq_z = np.zeros_like(z, dtype=np.float64)
        sum_z += z
        sum_sq_z += z * z
        n_done += 1

    mean_z = sum_z / n_done
    if n_done > 1:
        variance_z = np.maximum((sum_sq_z - n_done * mean_z * mean_z) / (n_done - 1), 0)
    else:
        variance_z = np.zeros_like(mean_z)
    sem_z = np.sqrt(variance_z) / np.sqrt(max(n_done, 1))
    group_t = mean_z / np.maximum(sem_z, 1e-6)
    print(f"Group t-stat range: [{group_t.min():.2f}, {group_t.max():.2f}]")

    dims = list(atlas4.shape)
    voxels_per_map = int(np.prod(dims))
    shards = []
    for start in range(0, 400, SHARD_SIZE):
        end = min(start + SHARD_SIZE, 400)
        maps = []
        for parcel_index in range(start, end):
            img = brain_masker.inverse_transform(group_t[parcel_index])
            img = resample_to_img(
                img,
                atlas4,
                interpolation="linear",
                force_resample=True,
                copy_header=True,
            )
            maps.append(np.asarray(img.dataobj).astype(np.float32))
        pack = np.stack(maps, axis=0).astype(np.float16)
        shard_name = f"schaefer400_fc_pack_dev155_4mm_{start:03d}-{end - 1:03d}.bin"
        shard_path = shard_dir / shard_name
        pack.tofile(shard_path)
        channel_labels = [str(i) for i in range(start + 1, end + 1)]
        shards.append({
            "id": f"{start + 1:03d}-{end:03d}",
            "filename": f"connectomes/schaefer400/{shard_name}",
            "sourceUrl": f"https://huggingface.co/datasets/sbollmann/lnm-webapp-models/resolve/main/connectomes/schaefer400/{shard_name}",
            "cacheKey": f"schaefer400-fc-dev155-4mm-{start + 1:03d}-{end:03d}-v1",
            "sizeBytes": shard_path.stat().st_size,
            "checksum": f"sha256:{sha256(shard_path)}",
            "channelLabels": channel_labels,
        })
        print(f"Shard {start + 1:03d}-{end:03d}: {shard_path.stat().st_size / 1e6:.2f} MB")

    index = {
        "dtype": "float16",
        "shape": [400, *dims],
        "voxelsPerMap": voxels_per_map,
        "atlasAssetId": "schaefer400-7n-4mm",
        "overlapAtlasAssetId": "schaefer400-7n-2mm",
        "parcelLabels": parcel_labels,
        "channelLabels": parcel_labels,
        "networkLabels": network_labels,
        "statistic": "group-tstat",
        "voxelOrder": "row-major",
        "source": f"development_fmri, {n_subjects} subjects, nilearn fetch_development_fmri",
        "atlasResolutionMm": 4,
        "shards": shards,
    }
    index_path = OUT_DIR / "schaefer400_fc_pack_dev155_4mm.index.json"
    index_path.write_text(json.dumps(index, indent=2) + "\n")
    print(f"Index: {index_path}, sha256={sha256(index_path)}")

    manifest_fragment = {
        "atlas4": {
            "sizeBytes": atlas4_path.stat().st_size,
            "checksum": f"sha256:{sha256(atlas4_path)}",
            "dims": dims,
        },
        "connectomeIndex": {
            "sizeBytes": index_path.stat().st_size,
            "checksum": f"sha256:{sha256(index_path)}",
        },
        "connectomeShardsTotalBytes": sum(shard["sizeBytes"] for shard in shards),
    }
    print(json.dumps(manifest_fragment, indent=2))

    if upload:
        upload_to_hf([atlas4_path], hf_token, repo_id, "atlases")
        upload_to_hf([index_path, *sorted(shard_dir.glob("*.bin"))], hf_token, repo_id, "connectomes/schaefer400")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--n-subjects", type=int, default=155)
    parser.add_argument("--upload", action="store_true")
    parser.add_argument("--hf-token", default=None)
    parser.add_argument("--repo-id", default="datasets/sbollmann/lnm-webapp-models")
    args = parser.parse_args()
    main(args.n_subjects, args.upload, args.hf_token, args.repo_id)
