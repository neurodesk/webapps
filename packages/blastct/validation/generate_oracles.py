#!/usr/bin/env python3
"""Generate upstream BLAST-CT v2.1.0 (v2 multi-centre model, checkpoint 1) oracles for parity.mjs.

Runs the real upstream `blast_ct` inference stack (`get_config_path`, `get_model`,
`get_test_loader`, `NiftiPatchSaver`, `ModelInference` with upstream's 110^3 test config)
from pinned `biomedia-mira/blast-ct` @ `613acbc1b6be455a44a9e6741eb899fbf082e6fd` (Apache-2.0).

Generates three head CT test cases from `blast_ct/data/scans/scan_0/scan_0_image.nii.gz`:
  1. `scan_0_head_ct.nii.gz` (integer-HU float32, 201x201x149, 1.0 mm) + `oracle_scan0.nii.gz`
  2. `scan_0_oblique_aniso.nii.gz` (12-deg pitch + 6-deg roll, X-flipped,
     anisotropic 0.85x0.85x3.0 mm, nonzero origin, float32) + `oracle_oblique.nii.gz`
  3. `scan_0_oblique_i16.nii.gz` (same oblique grid cast to int16 with identity scaling,
     used to measure ITK int16 resample truncation vs float32 JS resampling) + `oracle_oblique_i16.nii.gz`
"""
from __future__ import annotations

import argparse
import json
import math
import shutil
import sys
import tempfile
from pathlib import Path

import numpy as np
import pandas as pd
import SimpleITK as sitk
import torch


def run_upstream_case(
    input_path: Path,
    out_label_path: Path,
    device: torch.device,
) -> dict:
    from blast_ct.assets import get_config_path, get_model_path
    from blast_ct.nifti.savers import CLASS_NAMES, NiftiPatchSaver
    from blast_ct.read_config import get_model, get_test_loader
    from blast_ct.trainer.inference import ModelInference

    with open(get_config_path(), "r", encoding="utf-8") as fh:
        config = json.load(fh)
    if device.type == "cpu":
        config["test"]["batch_size"] = 32

    with tempfile.TemporaryDirectory() as job_dir:
        test_csv = Path(job_dir) / "test.csv"
        pd.DataFrame(data=[["im_0", str(input_path)]], columns=["id", "image"]).to_csv(
            test_csv, index=False
        )
        model = get_model(config)
        test_loader = get_test_loader(config, model, str(test_csv), use_cuda=device.type != "cpu")
        saver = NiftiPatchSaver(job_dir, test_loader, write_prob_maps=False, do_localisation=False)
        model_path = get_model_path(1)
        ModelInference(job_dir, device, model, saver, model_path, "segmentation")(test_loader)
        df = pd.read_csv(Path(job_dir) / "predictions" / "prediction.csv")
        shutil.copyfile(df.loc[0, "prediction"], out_label_path)

    img = sitk.ReadImage(str(input_path))
    out_img = sitk.ReadImage(str(out_label_path))
    out_arr = sitk.GetArrayFromImage(out_img)
    return {
        "size": img.GetSize(),
        "spacing": img.GetSpacing(),
        "counts": {CLASS_NAMES[i]: int((out_arr == i).sum()) for i in range(1, 5)},
    }


def make_oblique_aniso(src_img: sitk.Image) -> sitk.Image:
    # Realistic clinical oblique tilted-gantry CT (12 deg pitch, 6 deg roll,
    # flipped L-R direction, anisotropic 0.85 x 0.85 x 3.0 mm, nonzero origin).
    a, b = math.radians(12.0), math.radians(6.0)
    rx = np.array([[1, 0, 0], [0, math.cos(a), -math.sin(a)], [0, math.sin(a), math.cos(a)]])
    ry = np.array([[math.cos(b), 0, math.sin(b)], [0, 1, 0], [-math.sin(b), 0, math.cos(b)]])
    flip_x = np.diag([-1.0, 1.0, 1.0])
    direction = ry @ rx @ flip_x

    ref = sitk.Image([220, 220, 52], sitk.sitkFloat32)
    ref.SetSpacing([0.85, 0.85, 3.0])
    center_phys = np.array([100.0, 100.0, 74.0])
    half_extent = np.array([219 * 0.85, 219 * 0.85, 51 * 3.0]) * 0.5
    origin = center_phys - direction @ half_extent
    ref.SetOrigin(origin.tolist())
    ref.SetDirection(direction.flatten().tolist())
    min_val = float(np.min(sitk.GetArrayViewFromImage(src_img)))
    return sitk.Resample(src_img, ref, sitk.Transform(), sitk.sitkLinear, min_val, sitk.sitkFloat32)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--blast-ct-repo", type=Path, required=True)
    parser.add_argument("--out-dir", type=Path, required=True)
    parser.add_argument("--device", default="cpu")
    args = parser.parse_args()

    sys.path.insert(0, str(args.blast_ct_repo))
    from blast_ct.train import set_device

    device = set_device(args.device)
    args.out_dir.mkdir(parents=True, exist_ok=True)

    src_path = args.blast_ct_repo / "blast_ct" / "data" / "scans" / "scan_0" / "scan_0_image.nii.gz"
    src_img = sitk.ReadImage(str(src_path))

    # Integer-HU float32 (~7.0 MB vs 18.7 MB raw) matches upstream scan_0 dtype without ITK int16 truncation.
    f32_path = args.out_dir / "scan_0_head_ct.nii.gz"
    sitk.WriteImage(sitk.Cast(sitk.Round(src_img), sitk.sitkFloat32), str(f32_path))

    oblique_img = make_oblique_aniso(src_img)
    oblique_path = args.out_dir / "scan_0_oblique_aniso.nii.gz"
    sitk.WriteImage(oblique_img, str(oblique_path))

    oblique_i16_path = args.out_dir / "scan_0_oblique_i16.nii.gz"
    sitk.WriteImage(sitk.Cast(sitk.Round(oblique_img), sitk.sitkInt16), str(oblique_i16_path))

    for name, in_p, out_p in [
        ("scan_0_head_ct", f32_path, args.out_dir / "oracle_scan0.nii.gz"),
        ("scan_0_oblique_aniso", oblique_path, args.out_dir / "oracle_oblique.nii.gz"),
        ("scan_0_oblique_i16", oblique_i16_path, args.out_dir / "oracle_oblique_i16.nii.gz"),
    ]:
        info = run_upstream_case(in_p, out_p, device)
        print(f"{name}: {info}")


if __name__ == "__main__":
    main()
