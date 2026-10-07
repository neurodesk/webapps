---
"greedy": patch
---

Recover affine registrations that start on a shared grid. Greedy's default sample jitter (`-jitter 0.5`) was missing, so when the fixed and moving images shared a voxel grid the affine stayed at the identity while reporting success: a copy of the template turned 8° and shifted 9 mm came back 21 mm from the truth, and is now recovered to 0.4 mm. `greedy-rs -jitter SIGMA` sets the jitter; `-jitter 0` keeps the previous exact sampling.
