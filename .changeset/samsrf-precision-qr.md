---
"@neurodesk/samsrf": patch
"samsrf": patch
---

Solve Beta and Baseline as MATLAB's `[ones x] \ y` does: column-pivoted Householder QR in the design's class (single arithmetic for single observations), with MATLAB's rank rule. Single and double forward and CSS fits change in the last few bits of Beta and Baseline. Coefficients are not bit-identical to MATLAB in general: on 348 recorded MATLAB R2023b solves, 123 match bit for bit and the rest lie within the least-squares rounding bound, and every rank decision matches.
