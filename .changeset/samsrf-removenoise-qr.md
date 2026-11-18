---
"@neurodesk/samsrf": patch
"samsrf": patch
---

Regress the global signal out of double courses as MATLAB R2023b does in `samsrf_removenoise`: `B = [X ones] \ Y` by column-pivoted QR over every course at once, then `Y - X * B` with each row's rounded products added in column order. The double path solved each course's normal equations instead, which the single path had already stopped doing. On the AMD hosts of the pinned reverse-correlation recordings, every double residual now equals MATLAB's (52,500 of 52,500 values; 8,973 before), and the gate holds them bit for bit instead of within 1e-13 of a course's peak. Courses that the regression leaves as rounding now get MATLAB's maps there. On the pinned SamSrfAnalysis matrix, the double connective-field run with global-signal correction now matches MATLAB in R², Beta and Suppression; only its centroid y0 still differs. The Node/WASM matrix matches 17 of 24 runs and 157 of 168 maps (154 before). The rule was chosen from two operation orders on all recorded AMD values, with no separate held-out set; Intel hosts differ.
