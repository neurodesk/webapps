#!/usr/bin/env python3
"""External validation oracle #2: VesselVio (GPL-3.0, black-box execution only).

Runs a pinned checkout of JacobBumgarner/VesselVio headlessly via VVTerminal.py
on the pinned Lausanne TOF VesselBoost crop and compares its output CSV summary
against VesselCharter. No VesselVio source code is imported into VesselCharter.

Usage:
  VESSELVIO_DIR=/path/to/VesselVio python3 packages/vesselcharter/validation/vesselvio/compare.py
"""
from __future__ import annotations

import csv
import hashlib
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

import nibabel as nib

REPO_ROOT = Path(__file__).resolve().parents[4]
FIXTURE = REPO_ROOT / "apps/vesselboost/test/fixtures/upstream-reference/lausanne-tof-crop-192x192x64_vesselboost-manual_0429.nii.gz"
OUT_JSON = Path(__file__).resolve().parent / "results.json"


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def run_vesselcharter(mask_path: Path) -> dict:
    script = f"""
import {{ readFile }} from 'node:fs/promises';
import {{ characterizeVesselNifti }} from '{(REPO_ROOT / 'packages/vesselcharter/src/index.js').as_uri()}';

const bytes = await readFile({json.dumps(str(mask_path))});
const matched = await characterizeVesselNifti({{
  vesselBytes: bytes,
  parameters: {{ fillHoles: false, minComponentVoxels: 0, minSpurLengthMm: 1.0, minIsolatedLengthMm: 0 }},
}});
const defaults = await characterizeVesselNifti({{
  vesselBytes: bytes,
}});
console.log(JSON.stringify({{
  matched: matched.result.summary.network,
  defaults: defaults.result.summary.network,
  input: defaults.result.summary.input,
}}));
"""
    proc = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        capture_output=True,
        text=True,
        check=True,
    )
    return json.loads(proc.stdout)


def parse_vesselvio_results(results_dir: Path) -> dict:
    summary = {}
    for cf in sorted(results_dir.rglob("*.csv")):
        with cf.open("r", encoding="utf-8-sig", newline="") as f:
            raw_rows = list(csv.reader(f))
        if len(raw_rows) >= 3 and raw_rows[1] and raw_rows[1][0] == "Segment ID":
            headers = raw_rows[1]
            seg_rows = [dict(zip(headers, r)) for r in raw_rows[2:] if r and r[0]]
            lengths = [float(r["Length"]) for r in seg_rows if r.get("Length")]
            radii = [float(r["Mean Radius"]) for r in seg_rows if r.get("Mean Radius")]
            tort = [float(r["Tortuosity"]) for r in seg_rows if r.get("Tortuosity")]
            summary["segment_csv"] = {
                "segment_count": len(seg_rows),
                "total_length_mm": round(sum(lengths), 4),
                "mean_diameter_mm": round(2 * (sum(radii) / len(radii)), 4) if radii else None,
                "median_diameter_mm": round(2 * sorted(radii)[len(radii) // 2], 4) if radii else None,
                "mean_tortuosity": round(sum(tort) / len(tort), 4) if tort else None,
            }
    for xf in sorted(results_dir.rglob("*.xlsx")):
        import openpyxl

        wb = openpyxl.load_workbook(xf, data_only=True)
        for name in wb.sheetnames:
            ws = wb[name]
            rows = list(ws.iter_rows(values_only=True))
            # VesselVio Main Results places column headers on row index 1 and data on row index 2.
            if len(rows) >= 3:
                headers = [str(h).strip() if h is not None else "" for h in rows[1]]
                vals = rows[2]
                parsed = {}
                for h, v in zip(headers, vals):
                    if h and v is not None:
                        parsed[h] = round(float(v), 4) if isinstance(v, float) else v
                if parsed:
                    summary[name] = parsed
    return summary


def main() -> None:
    vv_dir = Path(os.environ.get("VESSELVIO_DIR", Path(tempfile.gettempdir()) / "vc-val" / "VesselVio"))
    if not (vv_dir / "VVTerminal.py").exists():
        raise SystemExit(f"VesselVio checkout not found at {vv_dir}; set VESSELVIO_DIR.")

    vv_commit = subprocess.check_output(
        ["git", "-C", str(vv_dir), "rev-parse", "HEAD"], text=True
    ).strip()

    img = nib.load(str(FIXTURE))
    zooms = [float(z) for z in img.header.get_zooms()[:3]]

    sys.path.insert(0, str(vv_dir))
    import VVTerminal
    from library import input_classes as IC

    with tempfile.TemporaryDirectory(prefix="vc-vesselvio-run-") as td:
        out_dir = Path(td) / "vv_out"
        out_dir.mkdir(parents=True, exist_ok=True)
        # VesselVio reads uncompressed .nii files via nibabel and resolves cache files from CWD.
        nii_path = Path(td) / "lausanne-tof-crop.nii"
        nib.save(img, str(nii_path))
        vis_options = IC.VisualizationOptions(
            False, False, False, False, False, False, False, False, False, "movie", "z", False
        )
        gen_options = IC.AnalysisOptions(
            str(out_dir),
            zooms,
            1.0,  # prune_length (mm)
            0.0,  # filter_length (mm)
            150,  # max_radius
            True,  # save_segment_results
            False,  # save_graph
            3,  # image_dimensions
        )
        no_annotation = IC.AnnotationOptions(None, None, "None", None)
        # VVTerminal.process_volume reads module-global results_folder when saving results.
        VVTerminal.results_folder = str(out_dir)
        old_cwd = os.getcwd()
        os.chdir(vv_dir)
        try:
            VVTerminal.process_volume(str(nii_path), gen_options, no_annotation, vis_options, 0, False)
        finally:
            os.chdir(old_cwd)
        vv_raw = parse_vesselvio_results(out_dir)

    vc = run_vesselcharter(FIXTURE)

    # Extract key comparable numbers from VesselVio's main summary table.
    vv_summary = {}
    for fname, content in vv_raw.items():
        if isinstance(content, dict) and any("Volume" in str(k) for k in content):
            vv_summary = content
            break
        if isinstance(content, dict):
            for sheet_name, sheet_vals in content.items():
                if isinstance(sheet_vals, dict) and any("Volume" in str(k) for k in sheet_vals):
                    vv_summary = sheet_vals
                    break
    if not vv_summary:
        vv_summary = vv_raw

    report = {
        "oracle": f"JacobBumgarner/VesselVio@{vv_commit} (GPL-3.0, external black-box execution only)",
        "fixture": {
            "path": str(FIXTURE.relative_to(REPO_ROOT)),
            "sha256": sha256_file(FIXTURE),
            "shape": list(img.shape),
            "spacing_mm": zooms,
        },
        "settings": {
            "resolution_mm": zooms,
            "prune_length_mm": 1.0,
            "filter_length_mm": 0.0,
        },
        "vesselvio_summary": vv_summary,
        "vesselcharter_matched": vc["matched"],
        "vesselcharter_defaults": vc["defaults"],
        "deliberate_differences": [
            "VesselCharter measures lengths and tortuosity on clamped Taubin-smoothed centerlines (while also exporting raw lattice lengths); VesselVio measures on unsmoothed skeleton graphs.",
            "VesselCharter computes subvoxel-centered inscribed-ellipsoid diameters plus Voronoi volume-equivalent diameters (D_eq) and flags resolution-limited segments (< 2 * max spacing); VesselVio uses its 4-nearest modified EDT.",
            "VesselCharter's Lee94 preserves all connected components and full branch tips (strict Step-2 endpoint guard + 2-voxel ribbon guard).",
        ],
    }

    OUT_JSON.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
