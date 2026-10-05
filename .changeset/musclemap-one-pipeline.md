---
"musclemap": patch
---

Run every model, including whole-body v1.3 and the regional models, through the upstream MONAI pipeline, and pad slices to upstream's 256 x 256 before 128 x 128 sliding windows. Remove the slice-thickness and low-res controls and their automation parameters, which only that older path used.
