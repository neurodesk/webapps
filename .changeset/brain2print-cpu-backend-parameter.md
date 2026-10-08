---
"brain2print": patch
---

Segment on the CPU when the only GPU is a software renderer. On machines without a usable GPU (virtual machines, remote desktops, blocklisted drivers) `auto` picked emulated WebGL2 and did not finish in 9 minutes; it now prefers hardware WebGPU, then hardware WebGL2, then the threaded CPU module, which takes about 30 s. Automation's `create-mesh` also accepts `backend: 'cpu'`.

Mesh the brain mask rather than the label values for the label models (16chan18cls, mindmap labels, mindsnap). Meshing the raw labels at isovalue 0.5 placed the surface almost at the background voxel, so printed brains came out 17–20 % too large (87 % for mindsnap); the mesh now encloses the labelled voxels to within 5 %.
