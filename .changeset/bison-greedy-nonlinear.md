---
"bison": minor
"@neurodesk/bison": minor
---

BISON's nonlinear registration to ICBM 2009c runs on Greedy with neighbourhood cross-correlation (radius 2, to 1 mm, from the inverse T1 affine) instead of ANTs SyN, so every BISON registration now runs on Greedy. On the five native validation subjects every label gate still holds and agreement is 0.936 to 0.946. The step takes about 10 minutes instead of 23 to 27, and its WebAssembly heap is 1.5 GB instead of 2.2 GB. Labels and probabilities change slightly; the browser reference is rerecorded.
