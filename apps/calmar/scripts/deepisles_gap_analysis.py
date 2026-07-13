#!/usr/bin/env python3
"""Compare a reference DeepISLES result against local CALMaR benchmark outputs.

This is a local diagnostic harness. It requires the user's Dice ~0.5
DeepISLES prediction as the reference artifact, rescoring it on the SOOP
combined TRACE-space lesion mask before comparing every available local
DeepISLES/SynthStroke-family prediction on the same grid.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

import nibabel as nib
import numpy as np
from scipy import ndimage

from benchmark_lesion_models import (
    DEFAULT_SOOP_MASK_ROOT,
    DEFAULT_SOOP_RAW_ROOT,
    ROOT,
    SOOP_CONTRASTS,
    BenchmarkError,
    fov_warning,
    load_nifti_3d,
    metrics,
    require_file,
    resample_binary_to_mask_grid,
    soop_combined_mask_path,
    soop_image_path,
)


DEFAULT_OUT_DIR = ROOT / ".tmp_weights" / "deepisles_gap_analysis"
DEFAULT_EXPECTED_REFERENCE_DICE = 0.5
DEFAULT_REFERENCE_TOLERANCE = 0.08


@dataclass(frozen=True)
class PredictionCandidate:
    mode: str
    path: Path
    source: str


def write_csv(path: Path, rows: list[dict[str, object]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if not rows:
        path.write_text("", encoding="utf-8")
        return
    fields: list[str] = []
    for row in rows:
        for key in row:
            if key not in fields:
                fields.append(key)
    with path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fields)
        writer.writeheader()
        writer.writerows(rows)


def rounded(value: object) -> object:
    if isinstance(value, float):
        return round(value, 6) if math.isfinite(value) else value
    return value


def mask_bbox(mask: np.ndarray) -> str:
    coords = np.argwhere(mask.astype(bool))
    if coords.size == 0:
        return ""
    mins = coords.min(axis=0)
    maxs = coords.max(axis=0)
    return ",".join(str(int(v)) for v in [*mins, *maxs])


def mask_centroid(mask: np.ndarray) -> str:
    coords = np.argwhere(mask.astype(bool))
    if coords.size == 0:
        return ""
    centroid = coords.mean(axis=0)
    return ",".join(f"{float(v):.3f}" for v in centroid)


def component_diagnostics(mask: np.ndarray) -> dict[str, int | str]:
    labels, count = ndimage.label(mask.astype(bool), structure=np.ones((3, 3, 3), dtype=np.uint8))
    if count == 0:
        return {"components": 0, "largest_component": 0, "component_sizes_top5": ""}
    sizes = np.bincount(labels.ravel())[1:]
    sorted_sizes = sorted((int(v) for v in sizes), reverse=True)
    return {
        "components": int(count),
        "largest_component": int(sorted_sizes[0]),
        "component_sizes_top5": ",".join(str(v) for v in sorted_sizes[:5]),
    }


def fov_overlap_fraction(source: nib.Nifti1Image, target: nib.Nifti1Image) -> float:
    from benchmark_lesion_models import fov_bounds

    source_min, source_max = fov_bounds(source.shape[:3], source.affine)
    target_min, target_max = fov_bounds(target.shape[:3], target.affine)
    inter_min = np.maximum(source_min, target_min)
    inter_max = np.minimum(source_max, target_max)
    inter_extent = np.maximum(0, inter_max - inter_min)
    target_extent = np.maximum(0, target_max - target_min)
    target_volume = float(np.prod(target_extent))
    inter_volume = float(np.prod(inter_extent))
    return inter_volume / target_volume if target_volume > 0 else 0.0


def score_prediction(
    candidate: PredictionCandidate,
    mask_image: nib.Nifti1Image,
    mask_data: np.ndarray,
    *,
    save_diff_dir: Path | None = None,
) -> tuple[dict[str, object], np.ndarray | None]:
    if not candidate.path.exists():
        return {
            "mode": candidate.mode,
            "source": candidate.source,
            "prediction": str(candidate.path),
            "status": "missing",
        }, None

    pred_image, pred_data, pred_notes = load_nifti_3d(candidate.path, binary=True)
    warning = fov_warning(pred_image, mask_image)
    pred_on_mask = resample_binary_to_mask_grid(pred_data, pred_image, mask_image)
    values = metrics(pred_on_mask, mask_data)
    diag = component_diagnostics(pred_on_mask)
    row: dict[str, object] = {
        "mode": candidate.mode,
        "source": candidate.source,
        "prediction": str(candidate.path),
        "status": "scored",
        "shape": "x".join(str(v) for v in pred_image.shape[:3]),
        "mask_grid_shape": "x".join(str(v) for v in mask_image.shape[:3]),
        "fov_overlap": round(fov_overlap_fraction(pred_image, mask_image), 6),
        "warning": warning or "",
        "notes": "; ".join(pred_notes),
        "centroid_vox": mask_centroid(pred_on_mask),
        "bbox_vox": mask_bbox(pred_on_mask),
        **diag,
    }
    row.update({key: rounded(value) for key, value in values.items()})

    if save_diff_dir is not None:
        diff = np.zeros(mask_data.shape, dtype=np.uint8)
        pred_bool = pred_on_mask.astype(bool)
        truth_bool = mask_data.astype(bool)
        diff[np.logical_and(pred_bool, truth_bool)] = 1
        diff[np.logical_and(pred_bool, ~truth_bool)] = 2
        diff[np.logical_and(~pred_bool, truth_bool)] = 3
        safe_mode = "".join(ch if ch.isalnum() or ch in "-_" else "_" for ch in candidate.mode)
        out_path = save_diff_dir / f"{safe_mode}_tp-fp-fn.nii.gz"
        nib.save(nib.Nifti1Image(diff, mask_image.affine, mask_image.header), str(out_path))
        row["diff_map"] = str(out_path)

    return row, pred_on_mask


def compare_to_reference(
    rows: list[dict[str, object]],
    masks_by_mode: dict[str, np.ndarray],
    reference_mode: str,
) -> list[dict[str, object]]:
    reference = masks_by_mode.get(reference_mode)
    if reference is None:
        return []
    out: list[dict[str, object]] = []
    for row in rows:
        mode = str(row.get("mode"))
        if row.get("status") != "scored" or mode == reference_mode:
            continue
        mask = masks_by_mode.get(mode)
        if mask is None:
            continue
        values = metrics(mask, reference)
        out.append({
            "mode": mode,
            "reference_mode": reference_mode,
            **{key: rounded(value) for key, value in values.items()},
        })
    return out


def default_candidates(subject: str, root: Path) -> list[PredictionCandidate]:
    candidates: list[PredictionCandidate] = []
    nvauto_dir = root / "deepisles_onnx_run" / f"{subject}_nvauto_allfolds"
    for path in sorted(nvauto_dir.glob(f"{subject}_deepisles-nvauto-model*_onnx_pred.nii.gz")):
        model_id = path.name.split("_deepisles-nvauto-")[1].split("_onnx_pred")[0]
        candidates.append(PredictionCandidate(f"deepisles-nvauto-{model_id}", path, "local NVAUTO ONNX fold"))
    candidates.extend([
        PredictionCandidate(
            "deepisles-nvauto-15fold",
            nvauto_dir / f"{subject}_deepisles-nvauto-15fold_onnx_pred.nii.gz",
            "local NVAUTO ONNX 15-fold mean",
        ),
        PredictionCandidate(
            "deepisles-seals-5fold-notta",
            root / "deepisles_component_runs" / f"{subject}_seals_mps_notta" / f"{subject}_seals-5fold-notta_pred.nii.gz",
            "local SEALS nnU-Net 5-fold no TTA",
        ),
        PredictionCandidate(
            "deepisles-factorizer",
            root / "deepisles_component_runs" / f"{subject}_factorizer_scored" / f"{subject}_deepisles-factorizer_pred_resampled_to_trace.nii.gz",
            "official Factorizer/SWAN component resampled to TRACE grid",
        ),
        PredictionCandidate(
            "deepisles-majority-available-components",
            root / "deepisles_component_runs" / f"{subject}_component_fusion" / f"{subject}_deepisles-majority-available-components.nii.gz",
            "available-component majority fusion",
        ),
    ])
    return candidates


def discover_benchmark_predictions(subject: str, root: Path) -> list[PredictionCandidate]:
    candidates: list[PredictionCandidate] = []
    for bench_dir in sorted(root.glob("lesion_model_benchmark*")):
        prediction_dir = bench_dir / "predictions"
        if not prediction_dir.exists():
            continue
        for path in sorted(prediction_dir.rglob(f"*{subject}*.nii.gz")):
            candidates.append(PredictionCandidate(
                f"benchmark-{bench_dir.name}-{path.stem.replace('.nii', '')}",
                path,
                "existing benchmark prediction",
            ))
    return candidates


def input_inventory(subject: str, raw_root: Path, mask_root: Path) -> list[dict[str, object]]:
    rows: list[dict[str, object]] = []
    for contrast in SOOP_CONTRASTS:
        path = soop_image_path(raw_root, subject, contrast)
        row: dict[str, object] = {
            "subject": subject,
            "contrast": contrast,
            "path": str(path),
            "exists": path.exists(),
        }
        if path.exists():
            image, _data, notes = load_nifti_3d(path)
            row.update({
                "shape": "x".join(str(v) for v in image.shape[:3]),
                "affine": json.dumps(np.asarray(image.affine).round(6).tolist()),
                "notes": "; ".join(notes),
            })
        rows.append(row)
    mask_path = soop_combined_mask_path(mask_root, subject)
    rows.append({
        "subject": subject,
        "contrast": "desc-lesion_mask",
        "path": str(mask_path),
        "exists": mask_path.exists(),
    })
    return rows


def summarize(
    subject: str,
    reference_row: dict[str, object],
    score_rows: list[dict[str, object]],
    comparison_rows: list[dict[str, object]],
    input_rows: list[dict[str, object]],
    expected_reference_dice: float,
    reference_tolerance: float,
) -> str:
    lines = [
        "# DeepISLES Gap Analysis",
        "",
        f"Subject: `{subject}`",
        "",
        "## Reference Rescore",
        "",
        "| Mode | Dice | Precision | Recall | Pred Voxels | Truth Voxels | Warning |",
        "| --- | ---: | ---: | ---: | ---: | ---: | --- |",
        (
            f"| {reference_row.get('mode')} | {float(reference_row.get('dice', math.nan)):.4f} | "
            f"{float(reference_row.get('precision', math.nan)):.4f} | "
            f"{float(reference_row.get('recall', math.nan)):.4f} | "
            f"{reference_row.get('pred_voxels', '')} | {reference_row.get('truth_voxels', '')} | "
            f"{reference_row.get('warning', '')} |"
        ),
    ]
    reference_dice = float(reference_row.get("dice", math.nan))
    if math.isfinite(reference_dice):
        delta = abs(reference_dice - expected_reference_dice)
        if delta > reference_tolerance:
            lines += [
                "",
                "## Stop Condition",
                "",
                (
                    f"The supplied reference rescored at Dice {reference_dice:.4f}, outside "
                    f"{expected_reference_dice:.2f} +/- {reference_tolerance:.2f}. Diagnose the scoring "
                    "target, affine/grid resampling, thresholding, or mask choice before comparing models."
                ),
            ]

    lines += [
        "",
        "## Local Predictions",
        "",
        "| Mode | Status | Dice | Precision | Recall | Pred Voxels | Reference Dice | Warning |",
        "| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |",
    ]
    comparison_by_mode = {row["mode"]: row for row in comparison_rows}
    for row in score_rows:
        comp = comparison_by_mode.get(row.get("mode"), {})
        lines.append(
            f"| {row.get('mode')} | {row.get('status')} | "
            f"{float(row.get('dice', math.nan)):.4f} | "
            f"{float(row.get('precision', math.nan)):.4f} | "
            f"{float(row.get('recall', math.nan)):.4f} | "
            f"{row.get('pred_voxels', '')} | "
            f"{float(comp.get('dice', math.nan)):.4f} | "
            f"{row.get('warning', '')} |"
        )

    lines += [
        "",
        "## Ablation Checklist",
        "",
        "- Input identity: confirm ADC, TRACE/DWI, FLAIR, and T1 paths in `input_inventory.csv`; singleton 4D inputs are noted there.",
        "- Spatial handling: inspect `warning`, `fov_overlap`, and reference Dice after mask-grid resampling.",
        "- Preprocessing: compare the reference against NVAUTO folds, SEALS, Factorizer, and component fusions before changing normalization.",
        "- Inference: use individual NVAUTO fold rows to separate fold choice from ensemble averaging.",
        "- Fusion/postprocessing: compare component majority/union outputs and empty Factorizer rows before changing thresholds.",
        "",
        "## Files",
        "",
        "- `results.csv`: metrics and geometric diagnostics for every prediction.",
        "- `reference_comparison.csv`: voxelwise agreement of each local prediction against the supplied DeepISLES reference.",
        "- `input_inventory.csv`: SOOP image and combined-mask paths, shapes, affine snapshots, and singleton-4D notes.",
    ]
    if any("diff_map" in row for row in score_rows):
        lines.append("- `diff_maps/`: label maps where 1=TP, 2=FP, 3=FN on the mask grid.")
    return "\n".join(lines) + "\n"


def run(args: argparse.Namespace) -> None:
    require_file(args.reference_prediction, "reference DeepISLES prediction mask")
    mask_path = args.scoring_mask or soop_combined_mask_path(args.soop_mask_root, args.subject)
    require_file(mask_path, f"{args.subject} combined TRACE-space lesion mask")

    for contrast in ["ADC", "TRACE"]:
        require_file(soop_image_path(args.soop_raw_root, args.subject, contrast), f"{args.subject} {contrast} image")

    args.out_dir.mkdir(parents=True, exist_ok=True)
    mask_image, mask_data, _mask_notes = load_nifti_3d(mask_path, binary=True)
    save_diff_dir = args.out_dir / "diff_maps" if args.save_diff_maps else None
    if save_diff_dir is not None:
        save_diff_dir.mkdir(parents=True, exist_ok=True)

    reference = PredictionCandidate("reference-deepisles-dice-0p5", args.reference_prediction, "user supplied DeepISLES output")
    reference_row, reference_mask = score_prediction(reference, mask_image, mask_data, save_diff_dir=save_diff_dir)
    assert reference_mask is not None

    candidates = default_candidates(args.subject, args.local_artifact_root)
    candidates.extend(discover_benchmark_predictions(args.subject, args.local_artifact_root))

    score_rows: list[dict[str, object]] = []
    masks_by_mode: dict[str, np.ndarray] = {reference.mode: reference_mask}
    for candidate in candidates:
        row, pred_mask = score_prediction(candidate, mask_image, mask_data, save_diff_dir=save_diff_dir)
        score_rows.append(row)
        if pred_mask is not None:
            masks_by_mode[candidate.mode] = pred_mask

    comparison_rows = compare_to_reference([reference_row, *score_rows], masks_by_mode, reference.mode)
    input_rows = input_inventory(args.subject, args.soop_raw_root, args.soop_mask_root)

    write_csv(args.out_dir / "results.csv", [reference_row, *score_rows])
    write_csv(args.out_dir / "reference_comparison.csv", comparison_rows)
    write_csv(args.out_dir / "input_inventory.csv", input_rows)
    (args.out_dir / "run_config.json").write_text(json.dumps({
        "subject": args.subject,
        "reference_prediction": str(args.reference_prediction),
        "scoring_mask": str(mask_path),
        "expected_reference_dice": args.expected_reference_dice,
        "reference_tolerance": args.reference_tolerance,
        "local_artifact_root": str(args.local_artifact_root),
    }, indent=2), encoding="utf-8")

    summary = summarize(
        args.subject,
        reference_row,
        score_rows,
        comparison_rows,
        input_rows,
        args.expected_reference_dice,
        args.reference_tolerance,
    )
    (args.out_dir / "summary.md").write_text(summary, encoding="utf-8")

    reference_dice = float(reference_row.get("dice", math.nan))
    print(summary, flush=True)
    print(f"Wrote {args.out_dir / 'summary.md'}", flush=True)
    if args.enforce_reference_dice and (
        not math.isfinite(reference_dice) or
        abs(reference_dice - args.expected_reference_dice) > args.reference_tolerance
    ):
        raise BenchmarkError(
            f"Reference prediction rescored at Dice {reference_dice:.4f}, outside "
            f"{args.expected_reference_dice:.2f} +/- {args.reference_tolerance:.2f}."
        )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--reference-prediction", type=Path, required=True,
                        help="Path to the DeepISLES prediction mask that scored about Dice 0.5.")
    parser.add_argument("--subject", default="sub-1")
    parser.add_argument("--scoring-mask", type=Path, default=None,
                        help="Optional explicit scoring mask. Defaults to the SOOP combined desc-lesion_mask.")
    parser.add_argument("--soop-raw-root", type=Path, default=DEFAULT_SOOP_RAW_ROOT)
    parser.add_argument("--soop-mask-root", type=Path, default=DEFAULT_SOOP_MASK_ROOT)
    parser.add_argument("--local-artifact-root", type=Path, default=ROOT / ".tmp_weights")
    parser.add_argument("--out-dir", type=Path, default=DEFAULT_OUT_DIR)
    parser.add_argument("--expected-reference-dice", type=float, default=DEFAULT_EXPECTED_REFERENCE_DICE)
    parser.add_argument("--reference-tolerance", type=float, default=DEFAULT_REFERENCE_TOLERANCE)
    parser.add_argument("--enforce-reference-dice", action="store_true",
                        help="Exit non-zero if the reference does not rescore near the expected Dice.")
    parser.add_argument("--save-diff-maps", action="store_true")
    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    try:
        run(args)
    except BenchmarkError as exc:
        raise SystemExit(f"ERROR: {exc}") from exc


if __name__ == "__main__":
    main()
