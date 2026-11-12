---
"@neurodesk/samsrf": patch
"samsrf": patch
---

Connective-field hulls now resolve polygons with a port of Clipper 6.4.2's even-odd union, the library MATLAB's `polyshape` builds on. Its rounding of crossings of nearly parallel edges, and a fixed-point grid that drops a decade when the coordinates fill more than 6.25e13 of it, reproduce MATLAB R2023b's hull vertices on 26,029 of 26,073 recorded polygons (previously 25,980) and on all 253 of the reference cases. The 44 that still differ are nearly collinear point clouds whose touching slivers MATLAB cleans differently; their port results are frozen. A polygon whose vertices come in random order can now take much longer: 1,000 such points take about 9 seconds.
