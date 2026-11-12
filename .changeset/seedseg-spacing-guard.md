---
"@neurodesk/seedseg": patch
---

Reject a zero or non-finite voxel spacing in the NIfTI header with a clear error before bias correction, as upstream's `seedseg_onnx.py` now does. A zero or NaN spacing was previously read as 1 mm, and an infinite one failed inside resampling with `Invalid typed array length`.
