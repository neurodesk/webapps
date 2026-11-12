---
"@neurodesk/samsrf": patch
"samsrf": patch
---

Single-precision connective-field profiles now equal MATLAB R2023b's bit for bit on the AMD (MKL CNR `auto`) reference host. `corr(y, X)` forms its product in MKL's recorded `y' * A` order (four-lane blocks of four columns, eight lanes for the rest) and limits coefficients to [-1, 1] as `corr.m` does. Without global-signal correction, every single convex-hull and summary-statistics map and every recorded profile matches. Single Gaussian CF fits (`Fit_pRF = 1`) stay refused. Their arithmetic (MATLAB's single `exp` and the mixed single and double objective) reproduces MATLAB's maps from MATLAB's template, but the Benson reader's x0 and y0, and the single global regression, are not yet bit-identical.
