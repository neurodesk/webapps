#!/usr/bin/env python3
"""
Convert staged SCT model assets into browser-packaged assets when possible.

The current browser worker requires ONNX Runtime Web-compatible ONNX models.
This script copies already-ONNX staged assets into web/models and records
conversion failures for SCT packages that still need a model-specific converter.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
from datetime import datetime, timezone
from pathlib import Path


BACKGROUND = {"index": 0, "name": "Background", "rgba": [0, 0, 0, 0], "meaning": "Background"}
LABELS = {
    "spinalcord": [BACKGROUND, {"index": 1, "name": "Spinal cord", "rgba": [68, 128, 255, 255], "meaning": "Spinal cord segmentation"}],
    "graymatter": [BACKGROUND, {"index": 1, "name": "Gray matter", "rgba": [255, 184, 76, 255], "meaning": "Spinal cord gray matter"}],
    "lesion_ms": [BACKGROUND, {"index": 1, "name": "Lesion", "rgba": [255, 66, 120, 255], "meaning": "Spinal cord lesion"}],
    "multiclass": [
        BACKGROUND,
        {"index": 1, "name": "Class 1", "rgba": [68, 128, 255, 255], "meaning": "Task-defined class 1"},
        {"index": 2, "name": "Class 2", "rgba": [255, 184, 76, 255], "meaning": "Task-defined class 2"},
        {"index": 3, "name": "Class 3", "rgba": [255, 66, 120, 255], "meaning": "Task-defined class 3"},
    ],
}


def labels_for_task(task: dict) -> list[dict]:
    task_id = task["id"]
    if task.get("outputType") == "multi-label-mask":
        return LABELS["multiclass"]
    if task.get("category") == "gray-matter":
        return LABELS["graymatter"]
    if task.get("category") == "pathology":
        return LABELS["lesion_ms"]
    return LABELS.get(task_id, LABELS["spinalcord"])


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def load_staging_manifest(input_dir: Path) -> dict:
    path = input_dir / "sct-download-manifest.json"
    if not path.exists():
        raise FileNotFoundError(f"Missing staging manifest: {path}")
    return json.loads(path.read_text(encoding="utf-8"))


def convert_task(task: dict, input_dir: Path, output_dir: Path) -> dict:
    task_id = task["id"]
    staged_onnx = input_dir / f"{task_id}.onnx"
    output_filename = f"sct-{task_id}.onnx"
    output_path = output_dir / output_filename

    model_asset = {
        "id": f"sct-{task_id}",
        "sourceUrl": task.get("sourceUrl", ""),
        "sourceVersion": task.get("sourceVersion", "stable"),
        "sourceFormat": "SCT model package",
        "browserFormat": "onnx",
        "filename": output_filename,
        "conversionStatus": "failed",
        "cacheKey": f"{task_id}:sct-{task_id}:{task.get('sourceVersion', 'stable')}",
        "failureReason": "No staged ONNX file was available for browser packaging."
    }

    support_status = task.get("supportStatus", "unsupported")
    validation_status = "not-run"

    if staged_onnx.exists():
        shutil.copy2(staged_onnx, output_path)
        model_asset.update({
            "sizeBytes": output_path.stat().st_size,
            "checksum": sha256(output_path),
            "conversionStatus": "native",
        })
        model_asset.pop("failureReason", None)
        support_status = "unvalidated"

    converted = {
        "id": task_id,
        "displayName": task["displayName"],
        "category": task["category"],
        "description": task.get("description", ""),
        "inputContrasts": task.get("inputContrasts", []),
        "requiredInputs": task.get("requiredInputs", []),
        "outputType": task.get("outputType", "unsupported"),
        "labels": labels_for_task(task),
        "modelAssets": [model_asset],
        "supportStatus": support_status,
        "validationStatus": validation_status,
    }
    if support_status != "supported":
        converted["unsupportedReason"] = task.get("unsupportedReason") or model_asset.get("failureReason", "Not validated for browser execution.")
    return converted


def main() -> int:
    parser = argparse.ArgumentParser(description="Package staged SCT model assets for the browser app")
    parser.add_argument("--input", default=".tmp_sct_models", help="Staged SCT model directory")
    parser.add_argument("--output", default="web/models", help="Browser model output directory")
    parser.add_argument("--task", default="all", help="Task id to convert, e.g. spinalcord")
    args = parser.parse_args()

    input_dir = Path(args.input)
    output_dir = Path(args.output)
    output_dir.mkdir(parents=True, exist_ok=True)

    staging = load_staging_manifest(input_dir)
    tasks = staging["tasks"] if args.task == "all" else [task for task in staging["tasks"] if task["id"] == args.task]
    if not tasks:
        raise SystemExit(f"Unknown task in staging manifest: {args.task}")

    existing_manifest_path = output_dir / "manifest.json"
    existing_tasks = []
    if existing_manifest_path.exists():
      existing_tasks = json.loads(existing_manifest_path.read_text(encoding="utf-8")).get("tasks", [])
    by_id = {task["id"]: task for task in existing_tasks}
    for task in tasks:
        by_id[task["id"]] = convert_task(task, input_dir, output_dir)

    manifest = {
        "schemaVersion": "1.0.0",
        "sctStableSource": staging.get("sctStableSource", "https://spinalcordtoolbox.com/stable/user_section/command-line/sct_deepseg.html"),
        "generatedAt": now_iso(),
        "tasks": list(by_id.values()),
    }
    existing_manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote browser model manifest: {existing_manifest_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
