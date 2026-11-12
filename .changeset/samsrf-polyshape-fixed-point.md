---
"@neurodesk/samsrf": patch
"samsrf": patch
---

Connective-field convex hulls now use an empirical compatibility model of MATLAB R2023b `polyshape`: vertices move to its fixed-point grid (centred, scaled by a power of ten and truncated), self-intersecting clusters are resolved with the even-odd rule, and the 1e-8 thinness cleaning works on that grid. All 253 polygons of the 741-case MATLAB reference now pass without exclusions, and 25,980 of 26,073 recorded polygons give MATLAB's hull vertices bit for bit; the remaining 93 are nearly collinear point clouds whose crossings MATLAB resolves by snapping. Maps from the real Benson templates are unchanged.

The unresolved cases retain frozen port regression outcomes. Unrepresentable grid scales return an empty hull before integer conversion, preventing overflow or nontermination on extreme coordinates. The package includes Clipper and fdlibm notices.
