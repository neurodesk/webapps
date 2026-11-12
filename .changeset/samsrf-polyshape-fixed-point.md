---
"@neurodesk/samsrf": patch
"samsrf": patch
---

Connective-field convex hulls now follow MATLAB's `polyshape` exactly as recorded in R2023b: vertices move to its fixed-point grid (centred, scaled by a power of ten and truncated), self-intersecting clusters are resolved with the even-odd rule, and the 1e-8 thinness cleaning works on that grid. All 253 polygons of the 741-case MATLAB reference now pass without exclusions, and 25,980 of 26,073 recorded polygons give MATLAB's hull vertices bit for bit; the remaining 93 are nearly collinear point clouds whose crossings MATLAB resolves by snapping. Maps from the real Benson templates are unchanged.
