---
"musclemap": patch
---

Ship whole-body v1.3 and the regional models as FP32 exports, which match upstream MuscleMap voxel for voxel on public parity cases. The previous Q8 exports could drop a whole label on partial-coverage scans. Each regional model download grows from about 39 MB to 104 MB.
