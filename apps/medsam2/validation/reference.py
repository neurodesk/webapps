"""Generate apps/medsam2/validation/reference.json from PyTorch SAM2VideoPredictor
(MedSAM2_latest.pt, sam2.1_hiera_t512, fill_hole_area=0, bilinear 512x512).

Usage:
  MEDSAM2_DIR=/path/to/MedSAM2 python reference.py --checkpoint MedSAM2_latest.pt --image T1_head.nii.gz
"""
import argparse
import json
import os
import sys
from pathlib import Path

import nibabel as nib
import numpy as np
import torch
import torch.nn.functional as F

MEDSAM2_DIR = Path(os.environ.get("MEDSAM2_DIR", "MedSAM2")).resolve()
if MEDSAM2_DIR.exists():
    sys.path.insert(0, str(MEDSAM2_DIR))

from sam2.build_sam import build_sam2_video_predictor_npz

IMG_MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)[:, None, None]
IMG_STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)[:, None, None]


def rle(mask_bool: np.ndarray) -> list[int]:
    flat = mask_bool.reshape(-1).astype(np.uint8)
    runs = []
    cur = 0
    count = 0
    for v in flat:
        if int(v) == cur:
            count += 1
        else:
            runs.append(count)
            cur = 1 - cur
            count = 1
    runs.append(count)
    return runs


def main():
    parser = argparse.ArgumentParser(description="Record PyTorch MedSAM2 3D reference masks.")
    parser.add_argument("--checkpoint", type=Path, required=True)
    parser.add_argument("--image", type=Path, required=True)
    parser.add_argument("--out", type=Path, default=Path(__file__).resolve().with_name("reference.json"))
    args = parser.parse_args()

    nii = nib.as_closest_canonical(nib.load(str(args.image)))
    data_xyz = nii.get_fdata(dtype=np.float32)
    nx, ny, nz = data_xyz.shape
    nz_vals = data_xyz[data_xyz > 0]
    lo, hi = [float(x) for x in np.percentile(nz_vals, [0.5, 99.5])]

    def extract_axial_u8(z: int) -> np.ndarray:
        sl = data_xyz[:, ::-1, z].T
        clamped = np.clip(sl, lo, hi)
        return np.trunc((clamped - lo) * (255.0 / max(hi - lo, 1e-7))).astype(np.uint8)

    def make_tensors(z0: int, z1: int) -> torch.Tensor:
        imgs = []
        for z in range(z0, z1 + 1):
            u8 = extract_axial_u8(z)
            t = torch.from_numpy(u8.astype(np.float32))[None, None]
            resized = F.interpolate(t, size=(512, 512), mode="bilinear", align_corners=False)[0, 0]
            # Match JS Math.round (half toward +inf) / 255.0 replicated across 3 channels.
            v = np.floor(resized.numpy() + 0.5) / 255.0
            rgb = np.stack([v, v, v], axis=0)
            imgs.append(((rgb - IMG_MEAN) / IMG_STD).astype(np.float32))
        return torch.from_numpy(np.stack(imgs, axis=0))

    predictor = build_sam2_video_predictor_npz("configs/sam2.1_hiera_t512.yaml", str(args.checkpoint), device="cpu")
    predictor.fill_hole_area = 0
    predictor.eval()

    def run_case(z0: int, z1: int, seed_z: int, box=None, points=None):
        tensors = make_tensors(z0, z1)
        key = seed_z - z0
        masks = {}
        with torch.inference_mode():
            state = predictor.init_state(tensors, ny, nx)
            for rev in (False, True):
                if rev:
                    predictor.reset_state(state)
                kwargs = {"inference_state": state, "frame_idx": key, "obj_id": 1}
                if box is not None:
                    kwargs["box"] = np.array(box, dtype=np.float32)
                if points is not None:
                    kwargs["points"] = np.array([[p[0], p[1]] for p in points], dtype=np.float32)
                    kwargs["labels"] = np.array([p[2] for p in points], dtype=np.int32)
                predictor.add_new_points_or_box(**kwargs)
                for idx, _, logits in predictor.propagate_in_video(state, reverse=rev):
                    masks[z0 + idx] = (logits[0, 0].cpu().numpy() > 0.0)
        return {str(z): {"area": int(masks[z].sum()), "runs": rle(masks[z])} for z in sorted(masks)}

    cases = [
        {
            "id": "axial-box-rolling-10",
            "prompt": {"axis": "axial", "slice": 81, "box": [58, 73, 107, 136], "propagate": True, "range": [73, 82]},
            "slices": run_case(73, 82, 81, box=[58, 73, 107, 136]),
        },
        {
            "id": "axial-point-5",
            "prompt": {"axis": "axial", "slice": 80, "points": [[88, 115, 1]], "propagate": True, "range": [78, 82]},
            "slices": run_case(78, 82, 80, points=[[88, 115, 1]]),
        },
    ]

    ref = {
        "image": args.image.name,
        "dims": [nx, ny, nz],
        "window": [lo, hi],
        "note": "PyTorch SAM2VideoPredictor (MedSAM2_latest.pt, sam2.1_hiera_t512, fill_hole_area=0, bilinear 512x512) reference masks; axial-box-rolling-10 spans 8 backward steps (rolling past num_maskmem=7) plus 1 forward step.",
        "cases": cases,
    }
    args.out.write_text(json.dumps(ref, indent=2) + "\n")


if __name__ == "__main__":
    main()
