#!/usr/bin/env python3
"""
Validate the SCT browser model manifest.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path


VALID_CATEGORIES = {"spinal-cord", "gray-matter", "pathology", "other-structure", "unsupported", "retired"}
VALID_OUTPUT_TYPES = {"binary-mask", "multi-label-mask", "soft-mask", "unsupported"}
VALID_SUPPORT = {"supported", "unsupported", "unvalidated", "retired"}
VALID_VALIDATION = {"not-run", "passed", "failed", "manual-only"}
VALID_CONVERSION = {"native", "converted", "failed", "not-needed"}
VALID_STAGE_KINDS = {"nifti", "metrics"}
VALID_ACTIVATIONS = {"sigmoid", "sigmoid-regions", "sigmoid-labels", "softmax"}


def fail(errors: list[str], message: str) -> None:
    errors.append(message)


def require(obj: dict, key: str, where: str, errors: list[str]) -> None:
    if key not in obj:
        fail(errors, f"{where}: missing required key '{key}'")


def validate_label(label: dict, where: str, errors: list[str]) -> None:
    for key in ("index", "name", "rgba", "meaning"):
        require(label, key, where, errors)
    rgba = label.get("rgba")
    if not isinstance(rgba, list) or len(rgba) != 4 or any(not isinstance(v, int) or v < 0 or v > 255 for v in rgba):
        fail(errors, f"{where}: rgba must be four integers from 0 to 255")


def validate_asset(asset: dict, where: str, model_dir: Path, errors: list[str]) -> None:
    for key in ("id", "sourceUrl", "sourceVersion", "sourceFormat", "conversionStatus"):
        require(asset, key, where, errors)
    if asset.get("conversionStatus") not in VALID_CONVERSION:
        fail(errors, f"{where}: invalid conversionStatus '{asset.get('conversionStatus')}'")
    filename = asset.get("filename")
    if filename and asset.get("conversionStatus") in {"native", "converted"}:
        path = model_dir / filename
        download_url = asset.get("downloadUrl")
        if not path.exists() and not download_url:
            fail(errors, f"{where}: model file does not exist: {path}")
        if download_url is not None and not isinstance(download_url, str):
            fail(errors, f"{where}: downloadUrl must be a string")
        if "checksum" not in asset:
            fail(errors, f"{where}: converted/native asset must include checksum")
        expected_size = asset.get("sizeBytes")
        if not isinstance(expected_size, int) or expected_size <= 0:
            fail(errors, f"{where}: converted/native asset must include positive sizeBytes")
        elif path.exists() and path.stat().st_size != expected_size:
            fail(errors, f"{where}: sizeBytes={expected_size} but file size is {path.stat().st_size}")
        if path.exists() and filename.endswith(".onnx"):
            size = path.stat().st_size
            prefix = path.read_bytes()[:128]
            if size < 1_000_000 or prefix.startswith(b"version https://git-lfs"):
                fail(errors, f"{where}: ONNX asset is unexpectedly small or is a Git LFS pointer: {path}")
        checksum = asset.get("checksum")
        if path.exists() and isinstance(checksum, str) and checksum.startswith("sha256:"):
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            if checksum != f"sha256:{digest}":
                fail(errors, f"{where}: checksum mismatch, manifest={checksum} file=sha256:{digest}")
    if asset.get("conversionStatus") == "failed" and not asset.get("failureReason"):
        fail(errors, f"{where}: failed conversion must include failureReason")
    output = asset.get("output")
    if output is not None:
        if output.get("activation") not in VALID_ACTIVATIONS:
            fail(errors, f"{where}.output: invalid activation '{output.get('activation')}'")
        if output.get("activation") == "sigmoid-regions":
            channel_count = output.get("channelCount")
            if not isinstance(channel_count, int) or channel_count < 1:
                fail(errors, f"{where}.output: sigmoid-regions must define positive channelCount")
            for region_index, region in enumerate(output.get("regions", [])):
                rwhere = f"{where}.output.regions[{region_index}]"
                for key in ("stage", "channel", "sourceLabels", "outputLabel"):
                    require(region, key, rwhere, errors)
                if isinstance(channel_count, int) and isinstance(region.get("channel"), int) and region["channel"] >= channel_count:
                    fail(errors, f"{rwhere}: channel {region['channel']} outside channelCount={channel_count}")
        if output.get("activation") == "sigmoid-labels":
            channel_count = output.get("channelCount")
            if not isinstance(channel_count, int) or channel_count < 1:
                fail(errors, f"{where}.output: sigmoid-labels must define positive channelCount")
            class_labels = output.get("classLabels")
            if not isinstance(class_labels, list) or len(class_labels) != channel_count:
                fail(errors, f"{where}.output: sigmoid-labels classLabels length must match channelCount")
            label_priority = output.get("labelPriority")
            if label_priority is not None:
                if not isinstance(label_priority, list) or not all(isinstance(label, int) for label in label_priority):
                    fail(errors, f"{where}.output: sigmoid-labels labelPriority must be a list of integer labels")
                elif isinstance(class_labels, list) and any(label not in class_labels for label in label_priority):
                    fail(errors, f"{where}.output: sigmoid-labels labelPriority must only reference classLabels")


def validate_template_asset(asset: dict, where: str, model_dir: Path, errors: list[str]) -> None:
    for key in ("id", "filename", "sourceUrl"):
        require(asset, key, where, errors)
    filename = asset.get("filename")
    if not filename:
        return

    path = model_dir / filename
    download_url = asset.get("downloadUrl")
    if not path.exists() and not download_url:
        fail(errors, f"{where}: template file does not exist: {path}")
    if download_url is not None and not isinstance(download_url, str):
        fail(errors, f"{where}: downloadUrl must be a string")

    expected_size = asset.get("sizeBytes")
    if expected_size is not None:
        if not isinstance(expected_size, int) or expected_size <= 0:
            fail(errors, f"{where}: sizeBytes must be a positive integer")
        elif path.exists() and path.stat().st_size != expected_size:
            fail(errors, f"{where}: sizeBytes={expected_size} but file size is {path.stat().st_size}")

    checksum = asset.get("checksum")
    if checksum is not None and not (isinstance(checksum, str) and checksum.startswith("sha256:")):
        fail(errors, f"{where}: checksum must be null or a sha256: digest")
    if path.exists() and isinstance(checksum, str) and checksum.startswith("sha256:"):
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        if checksum != f"sha256:{digest}":
            fail(errors, f"{where}: checksum mismatch, manifest={checksum} file=sha256:{digest}")


def validate_output_stage(stage: dict, where: str, errors: list[str]) -> None:
    for key in ("id", "kind"):
        require(stage, key, where, errors)
    if stage.get("kind") not in VALID_STAGE_KINDS:
        fail(errors, f"{where}: invalid kind '{stage.get('kind')}'")
    if stage.get("kind") == "nifti":
        for key in ("labelSet", "outputSuffix"):
            require(stage, key, where, errors)
    if stage.get("kind") == "metrics":
        derived = stage.get("derivedFrom")
        if not isinstance(derived, list) or len(derived) < 1:
            fail(errors, f"{where}: metrics stages must define derivedFrom")


def validate_task(task: dict, index: int, model_dir: Path, errors: list[str]) -> None:
    where = f"tasks[{index}]"
    for key in ("id", "displayName", "category", "inputContrasts", "requiredInputs", "outputType", "supportStatus", "validationStatus"):
        require(task, key, where, errors)
    if task.get("category") not in VALID_CATEGORIES:
        fail(errors, f"{where}: invalid category '{task.get('category')}'")
    if task.get("outputType") not in VALID_OUTPUT_TYPES:
        fail(errors, f"{where}: invalid outputType '{task.get('outputType')}'")
    if task.get("supportStatus") not in VALID_SUPPORT:
        fail(errors, f"{where}: invalid supportStatus '{task.get('supportStatus')}'")
    if task.get("validationStatus") not in VALID_VALIDATION:
        fail(errors, f"{where}: invalid validationStatus '{task.get('validationStatus')}'")
    if task.get("supportStatus") in {"unsupported", "retired"} and not task.get("unsupportedReason"):
        fail(errors, f"{where}: unsupported/retired tasks must include unsupportedReason")
    if task.get("supportStatus") == "supported" and task.get("validationStatus") not in {"passed", "manual-only"}:
        fail(errors, f"{where}: supported tasks must have validationStatus=passed or manual-only")
    labels = task.get("labels", [])
    if task.get("supportStatus") == "supported" and len(labels) < 2:
        fail(errors, f"{where}: supported tasks must define at least background and foreground labels")
    for label_index, label in enumerate(labels):
        validate_label(label, f"{where}.labels[{label_index}]", errors)
    seen_stages: set[str] = set()
    for stage_index, stage in enumerate(task.get("outputStages", [])):
        validate_output_stage(stage, f"{where}.outputStages[{stage_index}]", errors)
        stage_id = stage.get("id")
        if stage_id in seen_stages:
            fail(errors, f"{where}.outputStages[{stage_index}]: duplicate id '{stage_id}'")
        seen_stages.add(stage_id)
    for asset_index, asset in enumerate(task.get("modelAssets", [])):
        validate_asset(asset, f"{where}.modelAssets[{asset_index}]", model_dir, errors)
    for asset_index, asset in enumerate(task.get("templateAssets", [])):
        validate_template_asset(asset, f"{where}.templateAssets[{asset_index}]", model_dir, errors)


def validate_manifest(path: Path, task_filter: str | None = None) -> list[str]:
    errors: list[str] = []
    try:
        manifest = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        return [f"Could not parse manifest {path}: {exc}"]

    for key in ("schemaVersion", "sctStableSource", "generatedAt", "tasks"):
        require(manifest, key, "manifest", errors)
    if manifest.get("schemaVersion") != "1.0.0":
        fail(errors, "manifest: schemaVersion must be 1.0.0")
    tasks = manifest.get("tasks", [])
    if not isinstance(tasks, list) or not tasks:
        fail(errors, "manifest: tasks must be a non-empty list")
        return errors

    filtered = [task for task in tasks if task_filter in (None, "all", task.get("id"))]
    if task_filter not in (None, "all") and not filtered:
        fail(errors, f"manifest: task not found: {task_filter}")

    for index, task in enumerate(filtered):
        validate_task(task, index, path.parent, errors)
    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate SCT browser model manifest")
    parser.add_argument("--manifest", default="web/models/manifest.json")
    parser.add_argument("--task", default=None)
    parser.add_argument("--all-tasks", action="store_true")
    args = parser.parse_args()

    task_filter = "all" if args.all_tasks else args.task
    errors = validate_manifest(Path(args.manifest), task_filter)
    if errors:
        print("SCT manifest validation failed:", file=sys.stderr)
        for error in errors:
            print(f"- {error}", file=sys.stderr)
        return 1

    print(f"SCT manifest validation passed: {args.manifest}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
