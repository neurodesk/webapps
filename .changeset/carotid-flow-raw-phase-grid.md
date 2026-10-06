---
"carotid-flow": patch
"@neurodesk/carotid-flow": patch
---

Decode unrescaled raw Siemens phase (0–4095, zero velocity at 2048) with the VENC and measure it with the velocity method; it previously went to the variability method with the VENC ignored. Such a series without a VENC is refused, and so is a VENC beside an unsigned series that cannot be told apart from a speed image. An amplitude and phase pair whose affine or voxel spacing differ is now refused instead of being combined voxel for voxel.
