---
"@neurodesk/samsrf": patch
"samsrf": patch
---

Write MATLAB's NaN in every merged map and exported GIfTI: the negative quiet NaN `0xFFF8000000000000`, `0xFFC00000` in single, which MATLAB R2023b on x86-64 produces for its `NaN` constant and for invalid operations. The engine wrote Rust's positive NaN, so maps that agreed in every value still differed from MATLAB in their NaN bits: the connective-field hull x0 and y0 at one vertex each, and every map of the 11 rejected vertices of the double reverse-correlation Gaussian run. Earlier reports called these signed zeros. Every NaN of the pinned MATLAB recordings is the negative one (a census committed with its predictions before the held-out recordings were read). Against the AMD host of the pinned SamSrfAnalysis source recording, the Node/WASM matrix now matches 17 of 24 runs and 154 of 168 maps (15 and 145 before). A NaN that SamSrf passes on from its input is not covered by the recordings. Intel hosts, the global-signal sum, the double 2D reverse-correlation fits, geometry, and compiled-container and production-interface parity are still open, and both public single-fit refusals remain.
