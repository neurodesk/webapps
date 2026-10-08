---
"musclemap": patch
---

Whole-body v1.4 segmentation now has to match upstream MuscleMap's labels label by label, not only overall. On the body MRI test slab the app reproduces upstream's label map voxel for voxel, and the browser test fails if any of its 26 muscles drops below Dice 0.95. The 10 muscles that once fell short came from cropping every nonzero voxel instead of MONAI's positive ones; a unit test now checks the crop against MONAI.
