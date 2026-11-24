# TotalSegmentator

Browser-based whole-body CT and MRI anatomical segmentation powered by openly licensed Apache-2.0 **TotalSegmentator v2** nnU-Net models running locally on WebGPU or WebAssembly.

## Supported tasks

- **CT — Whole body (117 structures)**: Fast (3 mm, single 33 MB model) or Full resolution (1.5 mm, 5-part models with optional single-group selection: Muscles & bones, Vertebrae, Ribs, Organs, Cardiac & vessels).
- **MRI — Whole body (50 structures)**: Fast (3 mm, single 33 MB model) or Full resolution (1.5 mm, 2-part models with optional Muscles & bones or Organs subset).
- **MRI — Vertebrae (25 structures)**: Individual vertebrae and sacrum segmentation at 1.5 mm.
- **CT — Abdominal muscles (22 structures)**: High-resolution T4–L4 trunk and abdominal wall muscle segmentation, automatically cropped to the trunk using the 6 mm body model.

License-gated commercial TotalSegmentator tasks (`appendicular_bones`, `tissue_types`, `thigh_shoulder_muscles`) are not mirrored.

## Development

```bash
pnpm --filter totalsegmentator dev
pnpm --filter totalsegmentator test
pnpm --filter totalsegmentator build
pnpm --filter totalsegmentator test:e2e
```
