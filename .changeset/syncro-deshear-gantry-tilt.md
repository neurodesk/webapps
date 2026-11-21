---
"syncro": patch
"@neurodesk/syncro": patch
"greedy": patch
"@neurodesk/greedy": patch
---

SYNcro resamples a sheared scan (a gantry-tilted CT) onto an orthogonal grid that covers its whole world box before synthesis, filling with its darkest voxel (about -1000 HU in CT); a lesion map or pathological scan on that grid is desheared with it, and provenance records `desheared`. Before, Greedy read the sheared sform as a bare diagonal grid and normalized such a CT mirrored left to right. Greedy now refuses a sheared sform without a qform, as ITK does, instead of dropping its origin and orientation.
