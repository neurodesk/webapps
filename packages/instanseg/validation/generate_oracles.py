#!/usr/bin/env python3
"""Generate upstream InstanSeg brightfield_nuclei TorchScript oracles for parity.mjs.

Uses the pinned upstream `instanseg_models_v0.1.1/brightfield_nuclei.zip` TorchScript
model and `instanseg/instanseg` v0.1.2 (`bc36594d68e555ebd940f5917a1ce0eed6048b15`)
`HE_example.tif` crop to write:
  - he_brightfield_512.ome.tif + oracle_512.npy          (512x512, 0.50008 um/px, 1 tile)
  - he_brightfield_768.ome.tif + oracle_768.npy          (768x768, 0.50008 um/px, 2x2 tiled)
  - he_brightfield_501x499_033um.ome.tif + oracle_501x499_033um.npy (501x499, 0.33 um/px, non-integer scale)

Run with an environment containing torch, numpy, tifffile, imagecodecs, and instanseg==0.1.2:
  python3 packages/instanseg/validation/generate_oracles.py \
    --model-zip "$TMPDIR/brightfield_nuclei.zip" \
    --he-tiff "$TMPDIR/HE_example.tif" \
    --out-dir "$TMPDIR/instanseg-oracles"
"""
from __future__ import annotations

import argparse
import hashlib
import zipfile
from pathlib import Path

import numpy as np
import tifffile
import torch
from instanseg.inference_class import _rescale_to_pixel_size
from instanseg.utils.tiling import _sliding_window_inference
from instanseg.utils.utils import percentile_normalize

EXPECTED_ZIP_SHA256 = "427aa9cfe961b6d0012e2abf6befc6a9f76398db5d28dc2302ad911327d1c448"


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def run_upstream(model: torch.jit.ScriptModule, rgb_hwc: np.ndarray, pixel_size: float | None, tile_size: int = 512) -> np.ndarray:
    t = torch.from_numpy(np.ascontiguousarray(rgb_hwc.transpose(2, 0, 1))).float().unsqueeze(0)
    orig_h, orig_w = t.shape[-2], t.shape[-1]
    rescaled = False
    if pixel_size is not None and abs(pixel_size / 0.5 - 1.0) > 0.01:
        t = _rescale_to_pixel_size(t, pixel_size, 0.5)
        rescaled = True
    t = percentile_normalize(t[0]).unsqueeze(0)
    with torch.no_grad():
        if t.shape[-1] <= tile_size and t.shape[-2] <= tile_size:
            out = model(t)[0, 0].cpu()
        else:
            out = _sliding_window_inference(t[0], model, window_size=(tile_size, tile_size), sw_device="cpu", device="cpu", instanseg_kwargs={})[0, 0].cpu()
    if rescaled:
        out = torch.nn.functional.interpolate(out.float()[None, None], size=(orig_h, orig_w), mode="nearest")[0, 0]
    return out.to(torch.int32).numpy()


def save_ome_tiff(path: Path, rgb_hwc: np.ndarray, pixel_size_um: float) -> None:
    tifffile.imwrite(
        path,
        rgb_hwc,
        photometric="rgb",
        compression="zlib",
        ome=True,
        metadata={
            "axes": "YXS",
            "PhysicalSizeX": pixel_size_um,
            "PhysicalSizeXUnit": "µm",
            "PhysicalSizeY": pixel_size_um,
            "PhysicalSizeYUnit": "µm",
        },
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-zip", type=Path, required=True)
    parser.add_argument("--he-tiff", type=Path, required=True)
    parser.add_argument("--out-dir", type=Path, required=True)
    args = parser.parse_args()

    digest = sha256_file(args.model_zip)
    if digest != EXPECTED_ZIP_SHA256:
        raise SystemExit(f"brightfield_nuclei.zip SHA-256 mismatch: {digest} != {EXPECTED_ZIP_SHA256}")

    args.out_dir.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(args.model_zip) as zf:
        pt_path = args.out_dir / "instanseg.pt"
        pt_path.write_bytes(zf.read("instanseg.pt"))
    model = torch.jit.load(str(pt_path), map_location="cpu").eval()

    he = tifffile.imread(args.he_tiff)
    if he.ndim != 3 or he.shape[2] < 3:
        raise SystemExit(f"Expected HWC RGB TIFF, got {he.shape}")
    he = he[:, :, :3]

    native_um = 0.5000799232736573
    cases = [
        ("he_brightfield_512.ome.tif", "oracle_512.npy", he[200:712, 200:712], native_um),
        ("he_brightfield_768.ome.tif", "oracle_768.npy", he[100:868, 100:868], native_um),
        ("he_brightfield_501x499_033um.ome.tif", "oracle_501x499_033um.npy", he[200:699, 200:701], 0.33),
    ]
    for tif_name, npy_name, crop, um in cases:
        tif_path = args.out_dir / tif_name
        npy_path = args.out_dir / npy_name
        save_ome_tiff(tif_path, crop, um)
        labels = run_upstream(model, crop, um, tile_size=512)
        np.save(npy_path, labels)
        unique_count = int(np.count_nonzero(np.unique(labels)))
        print(f"{tif_name}: shape={crop.shape} um={um} nuclei={unique_count} -> {npy_name}")


if __name__ == "__main__":
    main()
