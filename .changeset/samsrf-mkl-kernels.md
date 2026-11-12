---
"@neurodesk/samsrf": patch
"samsrf": patch
---

Solve Beta and Baseline with the summation orders of MKL's own `?gemv`, `?ormqr`, `?trsv` and `?trsm` as MATLAB R2023b runs them on AMD hosts, read from MKL's summation trees, and with LAPACK's `?ladiv` in the reflectors. On 348 recorded MATLAB solves, 300 coefficients are now bit-identical (previously 123), including every real double design; the rest stay within the empirical acceptance scale. A new multi-column solve reproduces MATLAB's `A \ B` for reverse correlation and the global regression to adopt. Results on Intel hosts, where MKL's AVX-512 branch sums differently, are not reproduced.
