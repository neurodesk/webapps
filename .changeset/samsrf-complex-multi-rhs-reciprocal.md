---
"@neurodesk/samsrf": patch
"samsrf": patch
---

For complex least-squares solves with several right-hand sides, multiply by MKL's diagonal reciprocal with exact power-of-two prescaling. All 292 recorded complex 8-column MATLAB R2023b solves on the AMD reference hosts now match MATLAB's values, bit for bit except imaginary zeros MATLAB stores as real. Real and single-RHS arithmetic is unchanged; MKL's Intel AVX-512 branch remains unsupported.
