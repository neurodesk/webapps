---
"@neurodesk/topofit": patch
"topofit": patch
---

Resolve NIfTI-1 and NIfTI-2 world affines through one shared `resolveWorldAffine` function that applies `sform_code`/`qform_code` precedence, `qfac`, 180° quaternion normalization (`nifti_quatern_to_dmat44`), and `xyzt_units` millimetre scaling while refusing non-finite or singular affines. Align loaded NiiVue volumes onto that same millimetre grid without copying voxels so surfaces, QC overlays, region masks, and crosshair coordinates agree with the anatomy for qform-only NIfTI-2 scans and micrometre or metre scans in both formats, and guard viewer loads against stale completions after cancellation. NIfTI-1 millimetre outputs remain byte-identical.
