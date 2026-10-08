---
"qsmbly": patch
---

Default the smallest V-SHARP kernel radius to twice the largest voxel dimension, as QSM.jl does. Anisotropic data previously started from twice the smallest dimension; isotropic data is unchanged.
