# @neurodesk/totalsegmentator

Browser-native inference engine for openly licensed Apache-2.0 **TotalSegmentator v2** models (CT and MRI) on WebGPU and WebAssembly via ONNX Runtime Web.

## Included models

| Task | Resolution | Models | Classes | Notes |
| --- | --- | --- | --- | --- |
| `total` (CT) | Fast (3 mm) | `Dataset297` (33 MB) | 117 | Organs, vertebrae, cardiac & vessels, muscles & bones, ribs |
| `total` (CT) | Full (1.5 mm) | `Dataset291–295` (5 × 62 MB) | 117 | All 5 parts or individual anatomical subset |
| `total_mr` (MRI) | Fast (3 mm) | `Dataset852` (33 MB) | 50 | Organs, vertebrae, bones & trunk muscles |
| `total_mr` (MRI) | Full (1.5 mm) | `Dataset850–851` (2 × 62 MB) | 50 | Both parts or muscles / organs subset |
| `vertebrae_mr` (MRI) | Full (1.5 mm) | `Dataset756` (62 MB) | 25 | Individual vertebrae and sacrum on MRI |
| `abdominal_muscles` (CT) | Full (0.75×0.75×1 mm) | `Dataset300` (33 MB) + `Dataset952` (33 MB) | 22 | Automatic `body_trunc` crop (6 mm) followed by T4–L4 muscle segmentation |

License-gated commercial TotalSegmentator tasks (`appendicular_bones`, `tissue_types`, `thigh_shoulder_muscles`, etc.) are not mirrored or distributed by this package.

## Reference validation

To reproduce reference validation locally, create a working directory with:

- `onnx/`: the 12 pinned ONNX files listed in `model.manifest.json` (downloaded from `neurodeskorg/webapps` or exported with `scripts/export_model.py`).
- `refs/`: `example_ct_sm.nii.gz`, `example_mr_sm.nii.gz`, `example_seg_fast.nii.gz`, `example_seg.nii.gz`, and `example_seg_mr.nii.gz` from `wasserth/TotalSegmentator` `tests/reference_files/`.

Then run `node packages/totalsegmentator/validation/validate.mjs <workDir>` (or set `TOTALSEG_WORK_DIR`):

- **CT `total` fast (3 mm)** on `example_ct_sm.nii.gz` vs `example_seg_fast.nii.gz`: **mean Dice = 0.99976**, 46/369,660 differing voxels (0.012%) across 40 detected structures.
- **MRI `total_mr` full (1.5 mm, 2 parts)** on LPS `example_mr_sm.nii.gz` vs `example_seg_mr.nii.gz`: **mean Dice = 0.99945**, **99.987% voxel agreement** (27/212,940 differing voxels) across 23 detected structures, verifying canonical RAS reorientation (`asClosestCanonical` / `undoCanonical`), Z-score normalization and multi-part LUT combination.
- **CT `total` full (1.5 mm, 5 parts)** on `example_ct_sm.nii.gz` vs `example_seg.nii.gz`: **mean Dice = 0.98204**, **99.442% voxel agreement** (2,064/369,660 differing voxels).
- **MRI `vertebrae_mr`** (3 vertebrae detected) and **CT `abdominal_muscles`** (19 trunk-cropped muscles detected via 6 mm `body` model).
