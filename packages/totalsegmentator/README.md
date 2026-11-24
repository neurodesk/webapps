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

Validated with `node packages/totalsegmentator/validation/validate.mjs` against TotalSegmentator's upstream reference segmentations:

- **CT `total` fast (3 mm)** on `example_ct_sm.nii.gz` vs `example_seg_fast.nii.gz`: **mean Dice = 0.99971**, 68/369,660 differing voxels (0.018%) across 40 detected structures.
- **MRI `total_mr` full (1.5 mm, 2 parts)** on LPS `example_mr_sm.nii.gz` vs `example_seg_mr.nii.gz`: **99.946% voxel agreement** (115/212,940 differing voxels) across 24 detected structures, verifying canonical RAS reorientation (`asClosestCanonical` / `undoCanonical`), Z-score normalization and multi-part LUT combination.
- **CT `total` full (1.5 mm, 5 parts)** on `example_ct_sm.nii.gz` vs `example_seg.nii.gz`: **99.411% voxel agreement** (2,178/369,660 differing voxels).
