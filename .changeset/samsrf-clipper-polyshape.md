---
"@neurodesk/samsrf": patch
"samsrf": patch
---

Connective-field hulls now resolve polygons with a port of Clipper 6.4.2's even-odd union, the library MATLAB's `polyshape` builds on, on MATLAB's fixed-point grid `floor(log10(1.25e14 / span))`, established with a dedicated MATLAB R2023b probe. MATLAB's hull vertices are reproduced on 26,029 of 26,073 recorded polygons (previously 25,980), on all 253 reference cases, on all 27,648 grid-probe polygons and on 2,822 of 3,000 held-out clouds. The remaining differences are nearly collinear clouds, plus one held-out half-integer grid that MATLAB re-traces; four nearly collinear clouds that the previous model matched now differ, with hull areas off by 0.5 to 17 %. Coordinates outside the supported grid, or a failed Clipper sweep, now raise an error instead of an empty hull. Full-surface hull connective fields on the X001 example give bit-identical maps and take about 1.2 times as long.
