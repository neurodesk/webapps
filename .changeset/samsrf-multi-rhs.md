---
"@neurodesk/samsrf": patch
"samsrf": patch
---

Single-precision reverse-correlation profiles and the connective-field global-signal regression now solve every right-hand side in one least-squares call, as MATLAB does: `[Y ones] \ X` over all aperture pixels and `[X ones] \ Y` over all ROI courses. On the AMD (MKL CNR `auto`) reference host, single CF results with global-signal correction now equal MATLAB R2023b's bit for bit, residuals and profiles alike. Single RC profiles rise from 31% to 82-96% identical. A course with a NaN keeps its column position as zeros and comes back zeroed; MATLAB's result for such a course was not recorded. Single Gaussian CF fits stay refused because the Benson reader's x0 and y0 are not yet bit-identical.
