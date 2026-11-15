---
"@neurodesk/samsrf": patch
"samsrf": patch
---

Follow MATLAB R2023b's sparse `conv` for kernels of 2-8 taps (input order, every product rounded before it is added, on predictions with fewer than a quarter of their samples nonzero) and double the block for a convolution whose full output is exactly 8 blocks long (4,096 complex or 8,192 real samples). A third pre-registered recording on two AMD hosts held out both: 12 sparse short-kernel courses, where the previous path missed up to 3,766 parts per course, and the exact-8-block courses, where the previous block length missed 251-434. It also confirmed the complex and real thresholds and replayed the previous recording's 12 held-out courses byte for byte. Dense predictions, kernels of 9 taps or more away from exactly 8 blocks, and the public single RC 2D and CF Gaussian refusals are unchanged.
