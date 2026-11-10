#!/usr/bin/env python3
"""Stage the label atlases the knowledge-base report measures damage in.

CALMaR's report (atlas_mapping/ in the knowledge-base repository,
github.com/micmas/stroke-aphasia-kb) defines
its anatomical units on four label atlases. This script checks that each
atlas file carries the labels the mapping names and writes the matching
``atlasAssets`` entries (dims, affine origin, sha256, label table, hosted URL)
into ``web/models/manifest.json`` and ``packages/calmar/model.manifest.json``.
The file itself is copied, unchanged, into ``web/models/_dev_cache/`` (ignored
by git; ``test:manifest-checksums`` verifies it against the manifest), never
into ``web/``: the static build drops NIfTI files, so the browser fetches the
atlas from ``--url NAME=URL`` (a pinned, immutable copy: a GitHub raw URL at a
commit, or the Hugging Face dataset at a revision). Without a URL the entry
points at ``./models/<file>``, which only the dev server can serve.

Sources (the files are not downloaded here; put them where ``--from`` says):

  HarvardOxford  cort-maxprob-thr25-2mm (FSL 6, MNI152NLin6Asym 2 mm, 48 labels)
                 e.g. $FSLDIR/data/atlases/HarvardOxford/HarvardOxford-cort-maxprob-thr25-2mm.nii.gz,
                 or neurodata/neuroparc HarvardOxfordcort-maxprob-thr25_space-MNI152NLin6_res-2x2x2.nii.gz
  AAL            SPM12 AAL (ROI_MNI_V4, 116 labels, 2 mm)
                 e.g. neurodata/neuroparc AAL_space-MNI152NLin6_res-2x2x2.nii.gz
  JHU            $FSLDIR/data/atlases/JHU/JHU-ICBM-tracts-maxprob-thr50-2mm.nii.gz (+ JHU-tracts.xml)
  XTRACT         $FSLDIR/data/atlases/XTRACT/xtract-tract-atlases-maxprob5-1mm.nii.gz (+ XTRACT.xml)

Label order: HarvardOxford, JHU and XTRACT images carry FSL XML index + 1;
AAL carries 1..116 in ROI_MNI_V4 order. Without the XML files the script
uses the FSL 6.0.7 label lists embedded below and checks them against the
knowledge base's ``atlas_labels.json`` when ``--kb`` points at the KB.

    python3 scripts/build_report_atlases.py --from ../../../calmar/atlases-src --kb ../../../stroke-aphasia-kb \
        --url HarvardOxford=https://raw.githubusercontent.com/neurodata/neuroparc/<commit>/atlases/label/Human/HarvardOxfordcort-maxprob-thr25_space-MNI152NLin6_res-2x2x2.nii.gz \
        --url JHU=https://huggingface.co/datasets/neurodeskorg/webapps/resolve/<revision>/calmar/atlases/JHU-ICBM-tracts-maxprob-thr50-2mm.nii.gz
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import shutil
import struct
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

APP = Path(__file__).resolve().parents[1]
MANIFESTS = (APP / "web/models/manifest.json", APP.parents[1] / "packages/calmar/model.manifest.json")
DEST = APP / "web/models/_dev_cache"

HARVARD_OXFORD = [
    "Frontal Pole", "Insular Cortex", "Superior Frontal Gyrus", "Middle Frontal Gyrus",
    "Inferior Frontal Gyrus, pars triangularis", "Inferior Frontal Gyrus, pars opercularis", "Precentral Gyrus",
    "Temporal Pole", "Superior Temporal Gyrus, anterior division", "Superior Temporal Gyrus, posterior division",
    "Middle Temporal Gyrus, anterior division", "Middle Temporal Gyrus, posterior division",
    "Middle Temporal Gyrus, temporooccipital part", "Inferior Temporal Gyrus, anterior division",
    "Inferior Temporal Gyrus, posterior division", "Inferior Temporal Gyrus, temporooccipital part",
    "Postcentral Gyrus", "Superior Parietal Lobule", "Supramarginal Gyrus, anterior division",
    "Supramarginal Gyrus, posterior division", "Angular Gyrus", "Lateral Occipital Cortex, superior division",
    "Lateral Occipital Cortex, inferior division", "Intracalcarine Cortex", "Frontal Medial Cortex",
    "Juxtapositional Lobule Cortex (formerly Supplementary Motor Cortex)", "Subcallosal Cortex", "Paracingulate Gyrus",
    "Cingulate Gyrus, anterior division", "Cingulate Gyrus, posterior division", "Precuneous Cortex", "Cuneal Cortex",
    "Frontal Orbital Cortex", "Parahippocampal Gyrus, anterior division", "Parahippocampal Gyrus, posterior division",
    "Lingual Gyrus", "Temporal Fusiform Cortex, anterior division", "Temporal Fusiform Cortex, posterior division",
    "Temporal Occipital Fusiform Cortex", "Occipital Fusiform Gyrus", "Frontal Opercular Cortex",
    "Central Opercular Cortex", "Parietal Opercular Cortex", "Planum Polare", "Heschl's Gyrus (includes H1 and H2)",
    "Planum Temporale", "Supracalcarine Cortex", "Occipital Pole",
]
AAL = [
    "Precentral", "Frontal_Sup", "Frontal_Sup_Orb", "Frontal_Mid", "Frontal_Mid_Orb", "Frontal_Inf_Oper",
    "Frontal_Inf_Tri", "Frontal_Inf_Orb", "Rolandic_Oper", "Supp_Motor_Area", "Olfactory", "Frontal_Sup_Medial",
    "Frontal_Med_Orb", "Rectus", "Insula", "Cingulum_Ant", "Cingulum_Mid", "Cingulum_Post", "Hippocampus",
    "ParaHippocampal", "Amygdala", "Calcarine", "Cuneus", "Lingual", "Occipital_Sup", "Occipital_Mid", "Occipital_Inf",
    "Fusiform", "Postcentral", "Parietal_Sup", "Parietal_Inf", "SupraMarginal", "Angular", "Precuneus",
    "Paracentral_Lobule", "Caudate", "Putamen", "Pallidum", "Thalamus", "Heschl", "Temporal_Sup", "Temporal_Pole_Sup",
    "Temporal_Mid", "Temporal_Pole_Mid", "Temporal_Inf", "Cerebelum_Crus1", "Cerebelum_Crus2", "Cerebelum_3",
    "Cerebelum_4_5", "Cerebelum_6", "Cerebelum_7b", "Cerebelum_8", "Cerebelum_9", "Cerebelum_10",
]
AAL = [f"{name}_{side}" for name in AAL for side in ("L", "R")] + [
    "Vermis_1_2", "Vermis_3", "Vermis_4_5", "Vermis_6", "Vermis_7", "Vermis_8", "Vermis_9", "Vermis_10"]
JHU = [
    "Anterior thalamic radiation L", "Anterior thalamic radiation R", "Corticospinal tract L", "Corticospinal tract R",
    "Cingulum (cingulate gyrus) L", "Cingulum (cingulate gyrus) R", "Cingulum (hippocampus) L", "Cingulum (hippocampus) R",
    "Forceps major", "Forceps minor", "Inferior fronto-occipital fasciculus L", "Inferior fronto-occipital fasciculus R",
    "Inferior longitudinal fasciculus L", "Inferior longitudinal fasciculus R", "Superior longitudinal fasciculus L",
    "Superior longitudinal fasciculus R", "Uncinate fasciculus L", "Uncinate fasciculus R",
    "Superior longitudinal fasciculus (temporal part) L", "Superior longitudinal fasciculus (temporal part) R",
]
XTRACT = [
    "Arcuate Fasciculus L", "Arcuate Fasciculus R", "Acoustic Radiation L", "Acoustic Radiation R",
    "Anterior Thalamic Radiation L", "Anterior Thalamic Radiation R", "Cingulum subsection : Dorsal L",
    "Cingulum subsection : Dorsal R", "Cingulum subsection : Peri-genual L", "Cingulum subsection : Peri-genual R",
    "Cingulum subsection : Temporal L", "Cingulum subsection : Temporal R", "Corticospinal Tract L",
    "Corticospinal Tract R", "Frontal Aslant Tract L", "Frontal Aslant Tract R", "Forceps Major", "Forceps Minor",
    "Fornix L", "Fornix R", "Inferior Longitudinal Fasciculus L", "Inferior Longitudinal Fasciculus R",
    "Inferior Fronto-Occipital Fasciculus L", "Inferior Fronto-Occipital Fasciculus R", "Middle Cerebellar Peduncle",
    "Middle Longitudinal Fasciculus L", "Middle Longitudinal Fasciculus R", "Optic Radiation L", "Optic Radiation R",
    "Superior Thalamic Radiation L", "Superior Thalamic Radiation R", "Superior Longitudinal Fasciculus 1 L",
    "Superior Longitudinal Fasciculus 1 R", "Superior Longitudinal Fasciculus 2 L",
    "Superior Longitudinal Fasciculus 2 R", "Superior Longitudinal Fasciculus 3 L",
    "Superior Longitudinal Fasciculus 3 R", "Anterior Commissure", "Uncinate Fasciculus L", "Uncinate Fasciculus R",
    "Vertical Occipital Fasciculus L", "Vertical Occipital Fasciculus R",
]

ATLASES = {
    "HarvardOxford": dict(
        id="harvardoxford-cort-maxprob-thr25-2mm", filename="atlases/HarvardOxford-cort-maxprob-thr25-2mm.nii.gz",
        candidates=["HarvardOxford-cort-maxprob-thr25-2mm.nii.gz",
                    "HarvardOxfordcort-maxprob-thr25_space-MNI152NLin6_res-2x2x2.nii.gz"],
        xml=None, labels=HARVARD_OXFORD, resolutionMm=2, mniSpace="MNI152NLin6Asym",
        sourceVersion="HarvardOxford-cort-maxprob-thr25-2mm-FSL6", licence="FSL atlas licence (non-commercial)",
        comment=("Harvard-Oxford cortical structural atlas, maximum-probability image thresholded at 25%, "
                 "2 mm, as distributed with FSL 6 (labels = FSL XML index + 1). Bilateral labels: the report "
                 "takes the side from the lesion voxels' MNI x coordinate. One of the four label atlases the "
                 "knowledge-base atlas mapping (stroke-aphasia-kb/atlas_mapping) defines its units on."),
    ),
    "AAL": dict(
        id="aal-spm12-2mm", filename="atlases/AAL-SPM12-2mm.nii.gz",
        candidates=["AAL.nii.gz", "AAL_space-MNI152NLin6_res-2x2x2.nii.gz"],
        xml=None, labels=AAL, resolutionMm=2, mniSpace="MNI152",
        sourceVersion="AAL-SPM12-ROI_MNI_V4-2mm", licence="AAL (Tzourio-Mazoyer 2002), free for academic use",
        comment=("Automated Anatomical Labeling atlas (SPM12 release, ROI_MNI_V4 order, 116 regions) at 2 mm with "
                 "labels 1..116. Used where HarvardOxford has no label: subcortical nuclei, pars orbitalis, "
                 "temporal-pole subdivisions, Rolandic operculum, medial superior frontal gyrus."),
    ),
    "JHU": dict(
        id="jhu-icbm-tracts-maxprob-thr50-2mm", filename="atlases/JHU-ICBM-tracts-maxprob-thr50-2mm.nii.gz",
        candidates=["JHU-ICBM-tracts-maxprob-thr50-2mm.nii.gz"], xml="JHU-tracts.xml", labels=JHU,
        resolutionMm=2, mniSpace="MNI152NLin6Asym", sourceVersion="JHU-ICBM-tracts-maxprob-thr50-2mm-FSL6",
        licence="FSL atlas licence (non-commercial)",
        comment=("JHU white-matter tractography atlas, maximum-probability image thresholded at 50%, 2 mm, from "
                 "FSL 6 (labels = FSL XML index + 1). The 50% image has no voxels for the cingulum, uncinate or "
                 "temporal SLF; the mapping uses XTRACT for those tracts."),
    ),
    "XTRACT": dict(
        id="xtract-tract-atlases-maxprob5-1mm", filename="atlases/XTRACT-tract-atlases-maxprob5-1mm.nii.gz",
        candidates=["xtract-tract-atlases-maxprob5-1mm.nii.gz"], xml="XTRACT.xml", labels=XTRACT,
        resolutionMm=1, mniSpace="MNI152NLin6Asym", sourceVersion="XTRACT-HCP-tract-atlases-maxprob5-1mm-FSL6.0.7",
        licence="FSL atlas licence (non-commercial)",
        comment=("XTRACT HCP tract atlases (Warrington et al. 2020), maximum-probability image thresholded at 5%, "
                 "1 mm, from FSL 6.0.7 (labels = FSL XML index + 1): arcuate, frontal aslant, middle longitudinal "
                 "fasciculus, optic radiation, SLF 1-3, uncinate."),
    ),
}


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def nifti_header(path: Path):
    """dims, pixdims, qform/sform origin, datatype from a NIfTI-1 file (no nibabel needed)."""
    raw = path.read_bytes()
    if raw[:2] == b"\x1f\x8b":
        raw = gzip.decompress(raw)
    endian = "<" if struct.unpack("<i", raw[:4])[0] == 348 else ">"
    dims = struct.unpack(f"{endian}8h", raw[40:56])
    datatype = struct.unpack(f"{endian}h", raw[70:72])[0]
    pixdim = struct.unpack(f"{endian}8f", raw[76:108])
    srow = struct.unpack(f"{endian}12f", raw[280:328])
    return list(dims[1:4]), list(pixdim[1:4]), [srow[3], srow[7], srow[11]], datatype, raw


def unique_labels(raw: bytes, datatype: int, dims) -> set[int]:
    import array
    vox_offset = int(struct.unpack("<f", raw[108:112])[0])
    codes = {2: "B", 4: "h", 8: "i", 16: "f", 64: "d", 256: "b", 512: "H", 768: "I"}
    data = array.array(codes[datatype])
    n = dims[0] * dims[1] * dims[2]
    data.frombytes(raw[vox_offset:vox_offset + n * data.itemsize])
    return {int(v) for v in set(data)}


def labels_from_xml(path: Path) -> list[str]:
    return [el.text.strip() for el in sorted(ET.parse(path).findall(".//label"), key=lambda e: int(e.get("index")))]


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--from", dest="source", required=True, help="folder holding the atlas files")
    parser.add_argument("--kb", help="root of a stroke-aphasia-kb checkout, to check the labels against atlas_mapping/atlas_labels.json")
    parser.add_argument("--only", help="comma-separated atlas names to stage (default: those found)")
    parser.add_argument("--url", action="append", default=[], metavar="NAME=URL",
                        help="hosted, immutable URL the browser fetches NAME from (repeatable)")
    args = parser.parse_args(argv)
    source = Path(args.source)
    wanted = set(args.only.split(",")) if args.only else set(ATLASES)
    urls = dict(item.split("=", 1) for item in args.url)
    unknown = set(urls) - set(ATLASES)
    if unknown:
        raise SystemExit(f"--url names unknown atlases: {sorted(unknown)}")
    known = {}
    if args.kb:
        known = json.loads((Path(args.kb) / "atlas_mapping/atlas_labels.json").read_text())
    manifests = [(p, json.loads(p.read_text())) for p in MANIFESTS]
    DEST.mkdir(parents=True, exist_ok=True)
    staged = []
    for name, spec in ATLASES.items():
        if name not in wanted:
            continue
        found = next((source / c for c in spec["candidates"] if (source / c).is_file()), None)
        if found is None:
            print(f"{name}: not found under {source} (looked for {', '.join(spec['candidates'])}); skipped")
            continue
        labels = spec["labels"]
        if spec["xml"] and (source / spec["xml"]).is_file():
            labels = labels_from_xml(source / spec["xml"])
        if name in known:
            missing = sorted(set(known[name]) - set(labels))
            if missing:
                raise SystemExit(f"{name}: labels named by the knowledge base are not in the label table: {missing}")
        dims, pixdim, origin, datatype, raw = nifti_header(found)
        values = unique_labels(raw, datatype, dims) - {0}
        if max(values) > len(labels):
            raise SystemExit(f"{name}: image holds label {max(values)} but the table has {len(labels)} names")
        target = DEST / Path(spec["filename"]).name
        shutil.copyfile(found, target)
        url = urls.get(name)
        if url is None:
            print(f"{name}: no --url given; the entry points at ./models/{spec['filename']}, which only the dev "
                  "server serves (the static build drops NIfTI files)")
        entry = {
            "id": spec["id"], "filename": spec["filename"], "sizeBytes": target.stat().st_size,
            "checksum": f"sha256:{sha256(target)}", "cacheKey": f"{spec['id']}-v1",
            "sourceUrl": url or f"./models/{spec['filename']}", "sourceVersion": spec["sourceVersion"],
            "resolutionMm": spec["resolutionMm"], "mniSpace": spec["mniSpace"], "dims": dims,
            "originMm": [round(v, 3) for v in origin], "supportStatus": "supported",
            "role": "report-atlas", "reportAtlas": name, "licence": spec["licence"],
            "labelCount": len(labels), "labelsPresent": len(values),
            "labels": {str(i + 1): label for i, label in enumerate(labels)},
            "_comment": spec["comment"],
        }
        for _, manifest in manifests:
            assets = manifest["atlasAssets"]
            index = next((i for i, a in enumerate(assets) if a["id"] == entry["id"]), None)
            if index is None:
                assets.append(entry)
            else:
                assets[index] = entry
        staged.append(name)
        print(f"{name}: {target.relative_to(APP)} {dims} {len(values)} labels present, sha256 {entry['checksum'][7:19]}… "
              f"<- {entry['sourceUrl']}")
    for path, manifest in manifests:
        path.write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"staged {', '.join(staged) or 'nothing'}; manifests updated")


if __name__ == "__main__":
    main()
