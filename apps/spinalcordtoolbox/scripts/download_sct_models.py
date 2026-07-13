#!/usr/bin/env python3
"""
Download or stage Spinal Cord Toolbox stable model assets for browser packaging.

This script keeps a curated SCT stable task inventory in the repository. It can
download direct model package URLs when they are known, and it writes a staging
manifest that records unsupported or not-yet-converted tasks explicitly.
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path


SCT_STABLE_SOURCE = "https://spinalcordtoolbox.com/stable/user_section/command-line/sct_deepseg.html"

TASKS = [
    {
        "id": "spinalcord",
        "displayName": "Spinal cord",
        "category": "spinal-cord",
        "description": "Contrast-agnostic spinal cord segmentation from SCT stable.",
        "inputContrasts": ["T1w", "T2w", "T2star", "MT", "DWI", "MP2RAGE", "PSIR", "STIR", "EPI"],
        "requiredInputs": [{"role": "image", "contrast": "any supported spinal cord MRI contrast"}],
        "outputType": "binary-mask",
        "sourceUrl": "https://spinalcordtoolbox.com/stable/user_section/command-line/deepseg/spinalcord.html",
        "sourceVersion": "stable",
        "supportStatus": "unvalidated",
        "unsupportedReason": "SCT stable model package discovery succeeded, but browser-runnable ONNX conversion has not been validated.",
    },
    {
        "id": "graymatter",
        "displayName": "Gray matter",
        "category": "gray-matter",
        "description": "Spinal cord gray matter segmentation.",
        "inputContrasts": ["T2star"],
        "requiredInputs": [{"role": "image", "contrast": "T2star spinal cord MRI"}],
        "outputType": "binary-mask",
        "sourceUrl": "https://spinalcordtoolbox.com/stable/user_section/command-line/sct_deepseg.html",
        "sourceVersion": "stable",
        "supportStatus": "unsupported",
        "unsupportedReason": "Model architecture and preprocessing are not yet ported to the browser worker.",
    },
    {
        "id": "sc_lumbar_t2",
        "displayName": "Lumbar spinal cord T2",
        "category": "spinal-cord",
        "description": "Lumbar-region spinal cord segmentation for T2-weighted data.",
        "inputContrasts": ["T2w"],
        "requiredInputs": [{"role": "image", "contrast": "T2w lumbar spinal cord MRI"}],
        "outputType": "binary-mask",
        "sourceUrl": "https://spinalcordtoolbox.com/stable/user_section/command-line/sct_deepseg.html",
        "sourceVersion": "stable",
        "supportStatus": "unsupported",
        "unsupportedReason": "Not yet converted or validated for browser execution.",
    },
    {
        "id": "sc_epi",
        "displayName": "Spinal cord EPI",
        "category": "spinal-cord",
        "description": "Spinal cord segmentation for EPI-BOLD fMRI images.",
        "inputContrasts": ["EPI"],
        "requiredInputs": [{"role": "image", "contrast": "EPI-BOLD fMRI"}],
        "outputType": "binary-mask",
        "sourceUrl": "https://spinalcordtoolbox.com/stable/user_section/command-line/sct_deepseg.html",
        "sourceVersion": "stable",
        "supportStatus": "unsupported",
        "unsupportedReason": "Not yet converted or validated for browser execution.",
    },
    {
        "id": "sc_mouse_t1",
        "displayName": "Mouse spinal cord T1",
        "category": "spinal-cord",
        "description": "Mouse spinal cord segmentation for T1-weighted data.",
        "inputContrasts": ["T1w"],
        "requiredInputs": [{"role": "image", "contrast": "mouse T1w spinal cord MRI"}],
        "outputType": "binary-mask",
        "sourceUrl": "https://spinalcordtoolbox.com/stable/user_section/command-line/sct_deepseg.html",
        "sourceVersion": "stable",
        "supportStatus": "unsupported",
        "unsupportedReason": "Not yet converted or validated for browser execution.",
    },
    {
        "id": "gm_sc_7t_t2star",
        "displayName": "Gray matter 7T T2star",
        "category": "gray-matter",
        "description": "Spinal cord gray matter segmentation for 7T T2star data.",
        "inputContrasts": ["T2star"],
        "requiredInputs": [{"role": "image", "contrast": "7T T2star spinal cord MRI"}],
        "outputType": "binary-mask",
        "sourceUrl": "https://spinalcordtoolbox.com/stable/user_section/command-line/sct_deepseg.html",
        "sourceVersion": "stable",
        "supportStatus": "unsupported",
        "unsupportedReason": "Not yet converted or validated for browser execution.",
    },
    {
        "id": "gm_wm_exvivo_t2",
        "displayName": "Ex vivo gray/white matter T2",
        "category": "gray-matter",
        "description": "Ex vivo spinal cord gray and white matter segmentation for T2-weighted data.",
        "inputContrasts": ["T2w"],
        "requiredInputs": [{"role": "image", "contrast": "ex vivo T2w spinal cord MRI"}],
        "outputType": "multi-label-mask",
        "sourceUrl": "https://spinalcordtoolbox.com/stable/user_section/command-line/sct_deepseg.html",
        "sourceVersion": "stable",
        "supportStatus": "unsupported",
        "unsupportedReason": "Not yet converted or validated for browser execution.",
    },
    {
        "id": "gm_wm_mouse_t1",
        "displayName": "Mouse gray/white matter T1",
        "category": "gray-matter",
        "description": "Mouse spinal cord gray and white matter segmentation for T1-weighted data.",
        "inputContrasts": ["T1w"],
        "requiredInputs": [{"role": "image", "contrast": "mouse T1w spinal cord MRI"}],
        "outputType": "multi-label-mask",
        "sourceUrl": "https://spinalcordtoolbox.com/stable/user_section/command-line/sct_deepseg.html",
        "sourceVersion": "stable",
        "supportStatus": "unsupported",
        "unsupportedReason": "Not yet converted or validated for browser execution.",
    },
    {
        "id": "gm_mouse_t1",
        "displayName": "Mouse gray matter T1",
        "category": "gray-matter",
        "description": "Mouse spinal cord gray matter segmentation for T1-weighted data.",
        "inputContrasts": ["T1w"],
        "requiredInputs": [{"role": "image", "contrast": "mouse T1w spinal cord MRI"}],
        "outputType": "binary-mask",
        "sourceUrl": "https://spinalcordtoolbox.com/stable/user_section/command-line/sct_deepseg.html",
        "sourceVersion": "stable",
        "supportStatus": "unsupported",
        "unsupportedReason": "Not yet converted or validated for browser execution.",
    },
    {
        "id": "lesion_sci_t2",
        "displayName": "SCI lesion T2",
        "category": "pathology",
        "description": "Spinal cord injury lesion segmentation for T2-weighted data.",
        "inputContrasts": ["T2w"],
        "requiredInputs": [{"role": "image", "contrast": "T2w spinal cord injury MRI"}],
        "outputType": "binary-mask",
        "sourceUrl": "https://spinalcordtoolbox.com/stable/user_section/command-line/sct_deepseg.html",
        "sourceVersion": "stable",
        "supportStatus": "unsupported",
        "unsupportedReason": "Not yet converted or validated for browser execution.",
    },
    {
        "id": "lesion_ms",
        "displayName": "MS lesion",
        "category": "pathology",
        "description": "Contrast-agnostic multiple sclerosis lesion segmentation.",
        "inputContrasts": ["T1w", "T2w", "T2star", "MP2RAGE", "PSIR", "STIR"],
        "requiredInputs": [{"role": "image", "contrast": "supported MS spinal cord MRI contrast"}],
        "outputType": "binary-mask",
        "sourceUrl": "https://spinalcordtoolbox.com/stable/user_section/command-line/sct_deepseg.html",
        "sourceVersion": "stable",
        "supportStatus": "unsupported",
        "unsupportedReason": "Not yet converted or validated for browser execution.",
    },
    {
        "id": "lesion_ms_axial_t2",
        "displayName": "MS lesion axial T2",
        "category": "pathology",
        "description": "Multiple sclerosis lesion segmentation for axial T2-weighted data.",
        "inputContrasts": ["T2w"],
        "requiredInputs": [{"role": "image", "contrast": "axial T2w spinal cord MRI"}],
        "outputType": "binary-mask",
        "sourceUrl": "https://spinalcordtoolbox.com/stable/user_section/command-line/sct_deepseg.html",
        "sourceVersion": "stable",
        "supportStatus": "unsupported",
        "unsupportedReason": "Not yet converted or validated for browser execution.",
    },
    {
        "id": "lesion_ms_mp2rage",
        "displayName": "MS lesion MP2RAGE",
        "category": "pathology",
        "description": "Multiple sclerosis lesion segmentation for MP2RAGE data.",
        "inputContrasts": ["MP2RAGE"],
        "requiredInputs": [{"role": "image", "contrast": "MP2RAGE spinal cord MRI"}],
        "outputType": "binary-mask",
        "sourceUrl": "https://spinalcordtoolbox.com/stable/user_section/command-line/sct_deepseg.html",
        "sourceVersion": "stable",
        "supportStatus": "unsupported",
        "unsupportedReason": "Not yet converted or validated for browser execution.",
    },
    {
        "id": "tumor_edema_cavity_t1_t2",
        "displayName": "Tumor, edema, cavity",
        "category": "pathology",
        "description": "Multiclass spinal cord tumor, edema, and cavity segmentation.",
        "inputContrasts": ["T1w", "T2w"],
        "requiredInputs": [{"role": "image", "contrast": "T1w"}, {"role": "image", "contrast": "T2w"}],
        "outputType": "multi-label-mask",
        "sourceUrl": "https://spinalcordtoolbox.com/stable/user_section/command-line/sct_deepseg.html",
        "sourceVersion": "stable",
        "supportStatus": "unsupported",
        "unsupportedReason": "Requires multi-input workflow support before browser execution can be enabled.",
    },
    {
        "id": "tumor_t2",
        "displayName": "Tumor T2",
        "category": "pathology",
        "description": "Spinal cord tumor segmentation for T2-weighted data.",
        "inputContrasts": ["T2w"],
        "requiredInputs": [{"role": "image", "contrast": "T2w spinal cord tumor MRI"}],
        "outputType": "binary-mask",
        "sourceUrl": "https://spinalcordtoolbox.com/stable/user_section/command-line/sct_deepseg.html",
        "sourceVersion": "stable",
        "supportStatus": "unsupported",
        "unsupportedReason": "Not yet converted or validated for browser execution.",
    },
    {
        "id": "rootlets",
        "displayName": "Rootlets",
        "category": "other-structure",
        "description": "Spinal nerve rootlet segmentation.",
        "inputContrasts": ["T2w"],
        "requiredInputs": [{"role": "image", "contrast": "T2w"}],
        "outputType": "multi-label-mask",
        "sourceUrl": "https://spinalcordtoolbox.com/stable/user_section/command-line/sct_deepseg.html",
        "sourceVersion": "stable",
        "supportStatus": "unsupported",
        "unsupportedReason": "Not yet converted or validated for browser execution.",
    },
    {
        "id": "spine",
        "displayName": "TotalSpineSeg",
        "category": "other-structure",
        "description": "TotalSpineSeg spine and disc labeling from SCT stable.",
        "inputContrasts": ["CT", "MRI"],
        "requiredInputs": [{"role": "image", "contrast": "supported spine image"}],
        "outputType": "multi-label-mask",
        "sourceUrl": "https://spinalcordtoolbox.com/stable/user_section/command-line/sct_deepseg.html",
        "sourceVersion": "stable",
        "supportStatus": "unsupported",
        "unsupportedReason": "Not yet converted or validated for browser execution.",
    },
    {
        "id": "sc_canal_t2",
        "displayName": "Spinal canal T2",
        "category": "other-structure",
        "description": "Spinal canal segmentation for T2-weighted data.",
        "inputContrasts": ["T2w"],
        "requiredInputs": [{"role": "image", "contrast": "T2w spinal canal MRI"}],
        "outputType": "binary-mask",
        "sourceUrl": "https://spinalcordtoolbox.com/stable/user_section/command-line/sct_deepseg.html",
        "sourceVersion": "stable",
        "supportStatus": "unsupported",
        "unsupportedReason": "Not yet converted or validated for browser execution.",
    },
    {
        "id": "seg_sc_ms_lesion_stir_psir",
        "displayName": "Retired STIR/PSIR MS lesion",
        "category": "retired",
        "description": "Retired STIR/PSIR MS lesion model.",
        "inputContrasts": ["STIR", "PSIR"],
        "requiredInputs": [{"role": "image", "contrast": "STIR or PSIR spinal cord MRI"}],
        "outputType": "unsupported",
        "sourceUrl": "https://spinalcordtoolbox.com/stable/user_section/command-line/sct_deepseg.html",
        "sourceVersion": "stable",
        "supportStatus": "retired",
        "unsupportedReason": "Retired by SCT stable; use lesion_ms instead.",
    },
    {
        "id": "ms_sc_mp2rage",
        "displayName": "Retired MP2RAGE spinal cord",
        "category": "retired",
        "description": "Retired MP2RAGE spinal cord model.",
        "inputContrasts": ["MP2RAGE"],
        "requiredInputs": [{"role": "image", "contrast": "MP2RAGE spinal cord MRI"}],
        "outputType": "unsupported",
        "sourceUrl": "https://spinalcordtoolbox.com/stable/user_section/command-line/sct_deepseg.html",
        "sourceVersion": "stable",
        "supportStatus": "retired",
        "unsupportedReason": "Retired by SCT stable; use spinalcord instead.",
    },
    {
        "id": "sc_t2star",
        "displayName": "Retired T2star spinal cord",
        "category": "retired",
        "description": "Retired contrast-specific T2star spinal cord model.",
        "inputContrasts": ["T2star"],
        "requiredInputs": [{"role": "image", "contrast": "T2star spinal cord MRI"}],
        "outputType": "unsupported",
        "sourceUrl": "https://spinalcordtoolbox.com/stable/user_section/command-line/sct_deepseg.html",
        "sourceVersion": "stable",
        "supportStatus": "retired",
        "unsupportedReason": "Retired by SCT stable; use spinalcord or sc_epi depending on data.",
    },
]


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def write_staging_manifest(output_dir: Path, tasks: list[dict]) -> Path:
    manifest = {
        "schemaVersion": "1.0.0",
        "sctStableSource": SCT_STABLE_SOURCE,
        "generatedAt": now_iso(),
        "tasks": tasks,
    }
    path = output_dir / "sct-download-manifest.json"
    path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return path


def download_url(url: str, output_path: Path) -> None:
    with urllib.request.urlopen(url) as response:
        output_path.write_bytes(response.read())


def main() -> int:
    parser = argparse.ArgumentParser(description="Stage SCT stable model metadata and optional direct model downloads")
    parser.add_argument("--stable", action="store_true", help="Use SCT stable task metadata")
    parser.add_argument("--task", default="all", help="Task id to stage, e.g. spinalcord")
    parser.add_argument("--output", default=".tmp_sct_models", help="Output staging directory")
    parser.add_argument("--custom-url", action="append", default=[], help="Direct model package URL to download")
    args = parser.parse_args()

    output_dir = Path(args.output)
    output_dir.mkdir(parents=True, exist_ok=True)

    tasks = TASKS if args.task == "all" else [task for task in TASKS if task["id"] == args.task]
    if not tasks:
        print(f"Unknown SCT task: {args.task}", file=sys.stderr)
        return 2

    for url in args.custom_url:
        name = url.rstrip("/").split("/")[-1] or "sct-model.zip"
        target = output_dir / name
        print(f"Downloading {url} -> {target}")
        download_url(url, target)

    manifest_path = write_staging_manifest(output_dir, tasks)
    print(f"Wrote SCT staging manifest: {manifest_path}")
    print("No patient-derived data is downloaded or written by this script.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
