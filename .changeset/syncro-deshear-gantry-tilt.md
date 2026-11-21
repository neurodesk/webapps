---
"syncro": patch
"@neurodesk/syncro": patch
"greedy": patch
"@neurodesk/greedy": patch
---

SYNcro resamples sheared images such as gantry-tilted CT onto an orthogonal grid that covers the source voxels. Areas outside the scan take its darkest intensity. Lesion masks use nearest-neighbor sampling on the corresponding scan grid. Provenance records which inputs were resampled. Greedy now reports an error for a sheared sform without a qform, matching ITK.
