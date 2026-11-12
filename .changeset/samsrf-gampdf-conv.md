---
'@neurodesk/samsrf': patch
---

SamSrf: the de Haas and SPM HRF kernels now equal MATLAB R2023b's bit for bit. `gampdf` for shapes of at least 1 follows the saddle-point formula MATLAB's densities show, and `sum` and `conv` follow MATLAB's order for short kernels, kernels longer than the course and sparse courses. With the port's own HRF, the recorded double CSS pipeline now matches every fitted parameter, R², nR² and noise ceiling exactly at all 96 vertices, including the weak fits at vertices 14, 15, 51 and 81. The same holds for a nonnegative-aperture control recorded afresh. Beta and Baseline are gated against the exact least-squares solution. Shapes below 1 and sparse complex convolutions longer than 800 samples keep their previous few-ULP differences.
