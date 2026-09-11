---
"@neurodesk/greedy": patch
"greedy": patch
"edgereg": patch
---

Normalize NIfTI spatial units to millimetres and preserve scaled integer intensities when writing registered images. Isolate registration workers so cancelled input reads cannot affect a subsequent run.

Use the shared download helper in both registration apps and expose Greedy command-line instructions through the application bar.
