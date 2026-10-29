---
"@neurodesk/hmc-registration": patch
---

`run` accepts an `antsApplyTransforms` transform whose brackets are split over argv tokens (`[`, `affine.mat,`, `1`, `]`), as sdcflows' nipype renders native command lines, instead of refusing it as an input named `""`; the kernel writes the same image as for `[affine.mat,1]` (#462).

Malformed bracketed transforms are rejected before calling WebAssembly, so the instance remains usable for later valid calls.
