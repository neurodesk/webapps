---
"@neurodesk/samsrf": patch
"samsrf": patch
---

Connective-field hulls now resolve polygons with a port of Clipper 6.4.2's even-odd union, the library MATLAB's `polyshape` builds on. The model uses MATLAB's fixed-point grid `floor(log10(1.25e14 / span))`, reverses negatively wound input rings behind their first vertex, and keeps Clipper's own cleaning comparisons; dedicated MATLAB R2023b probes established all three. MATLAB's hull vertices are reproduced on 26,029 of 26,073 recorded polygons (previously 25,980), all 253 reference cases, all 27,648 grid-probe polygons, 2,822 of 3,000 held-out clouds and all 10,346 controlled sliver, bisection, hole and held-out strip polygons. Four nearly collinear clouds that the previous model matched still differ (hull areas off by 0.5 to 17 %) and block release. Coordinates outside the supported grid, or a failed Clipper sweep, now raise an error instead of an empty hull. Full-surface hull connective fields on the X001 example are unchanged.
