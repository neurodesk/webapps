---
"greedy": patch
"@neurodesk/greedy": patch
---

The threaded browser build of Greedy may grow to 2 GiB instead of 1 GiB. Reslicing a full-resolution CT (512 × 507 × 356 voxels after de-shearing, about 370 MB) aborted at 1 GiB and completes at 2 GiB. Results are unchanged.
