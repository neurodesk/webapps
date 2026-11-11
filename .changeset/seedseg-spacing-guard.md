---
"@neurodesk/seedseg": patch
---

Reject a non-finite or non-positive voxel spacing with a clear error before bias correction, as upstream's `seedseg_onnx.py` now does. An infinite spacing previously failed inside resampling with `Invalid typed array length`.
