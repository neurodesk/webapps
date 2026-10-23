"""Dump the reference pre-encode 8-bit frame stacks as golden fixtures.

This imports the reference functions from MRI2vid.py and reproduces the exact
steps of process_dicom_files up to the point just before frames are written to
the video (rescale, global min/max normalize, orientation reslice, slice range).
The encoded video is lossy and is not a parity target; the frame stack is.

Run after gen_phantom.py:

    python tools/gen_phantom.py && python tools/gen_reference.py
"""

import json
import sys
from pathlib import Path

import numpy as np
import cv2

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parent
OUT = ROOT / "phantom_out"
GOLDEN = ROOT / "golden"

sys.path.insert(0, str(REPO))
import MRI2vid as ref  # noqa: E402


def frame_stack(folder, orientation, start, end, step):
    """Mirror process_dicom_files up to `oriented = oriented_full[slice_indices]`."""
    datasets = ref.load_and_sort_dicoms(str(folder))

    base_shape = datasets[0].pixel_array.shape
    frames = []
    for idx, ds in enumerate(datasets):
        array = ds.pixel_array
        if array.shape != base_shape:
            raise ValueError(f"Slice {idx} shape mismatch")
        slope = getattr(ds, "RescaleSlope", 1.0)
        intercept = getattr(ds, "RescaleIntercept", 0.0)
        try:
            slope = float(slope)
        except (TypeError, ValueError):
            slope = 1.0
        try:
            intercept = float(intercept)
        except (TypeError, ValueError):
            intercept = 0.0
        frames.append(array.astype(np.float32) * slope + intercept)

    volume = np.stack(frames, axis=-1)
    volume = cv2.normalize(volume, None, 0, 255, cv2.NORM_MINMAX, dtype=cv2.CV_8U)

    oriented_full = ref.get_orientation_slice(orientation, volume)
    total = oriented_full.shape[0]

    def resolve(value, default):
        if value is None:
            return default
        if value < 0:
            value += total
        return value

    start_idx = resolve(start, 0)
    end_idx = min(resolve(end, total), total)
    slice_indices = list(range(start_idx, end_idx, step))
    oriented = oriented_full[slice_indices]
    return np.ascontiguousarray(oriented), slice_indices, total


CONFIGS = [
    # (name, source folder key, orientation, start, end, step)
    ("single_axial", "single", "axial", None, None, 1),
    ("single_sagittal", "single", "sagittal", None, None, 1),
    ("single_coronal", "single", "coronal", None, None, 1),
    ("single_axial_flipped", "single", "axial_flipped", None, None, 1),
    ("single_sagittal_flipped", "single", "sagittal_flipped", None, None, 1),
    ("single_coronal_flipped", "single", "coronal_flipped", None, None, 1),
    ("single_sagittal_range", "single", "sagittal", 1, 4, 2),
    ("single_axial_negstart", "single", "axial", -3, None, 1),
    ("single_coronal_step2", "single", "coronal", 0, None, 2),
    ("mf_axial", "mf", "axial", None, None, 1),
    ("mf_sagittal", "mf", "sagittal", None, None, 1),
]

FOLDERS = {
    "single": OUT / "dicom_single",
    "mf": OUT / "dicom_mf",
}


def main():
    GOLDEN.mkdir(parents=True, exist_ok=True)
    entries = []
    for name, src, orientation, start, end, step in CONFIGS:
        stack, indices, total = frame_stack(FOLDERS[src], orientation, start, end, step)
        (GOLDEN / f"{name}.bin").write_bytes(stack.tobytes())
        entries.append({
            "name": name,
            "source": src,
            "orientation": orientation,
            "start": start,
            "end": end,
            "step": step,
            "total_slices": total,
            "slice_indices": indices,
            "shape": list(stack.shape),  # (nFrames, H_out, W_out)
            "dtype": str(stack.dtype),
        })
        print(f"{name}: shape {stack.shape}, indices {indices}")

    (GOLDEN / "manifest.json").write_text(json.dumps({"configs": entries}, indent=2))
    print("Wrote frame-stack goldens to", GOLDEN)


if __name__ == "__main__":
    main()
