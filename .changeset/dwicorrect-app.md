---
"dwicorrect": minor
"@neurodesk/shoreline": minor
"@neurodesk/webapp-components": patch
---

DWI Correct is a new app that corrects a diffusion series in the browser as FSL eddy does: head motion, eddy-current fields, the susceptibility field and slices that lost signal are estimated together, and every volume is resampled once with Jacobian modulation. Drop the series with its bval, bvec and JSON sidecar, as NIfTI, a BIDS folder or DICOM, and optionally a reverse phase-encoding b0 (the field is then estimated with the SDC app's PyHySCO port), topup's `_fieldcoef` image or a field map in Hz. The brain mask is MindGrab's, from the mean b0. The outputs use BIDS derivative names: the corrected series with its bval, rotated bvec and sidecar, the movement and outlier slices per volume, the mask, the field, the log and a before/after GIF. Series that need more than WebAssembly's 4 GB are refused with a pointer to the native command line. The example is OpenNeuro ds006676 sub-001 (multiband 3, with a PA b0).

`@neurodesk/shoreline` loads the WebAssembly build of `exes/dwi/shoreline`, an eddy-like command line written from the eddy papers without FSL code, threaded on cross-origin isolated pages and single-threaded elsewhere. It runs the native command line's code, and its outputs agree with the native binary's on a phantom.

Numeric cells of shared data tables (`.nd-data-table .nd-numeric`) no longer wrap; a wide table scrolls instead.
