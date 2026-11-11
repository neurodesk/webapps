---
"@neurodesk/samsrf": patch
"samsrf": patch
---

Connective-field convex hulls now triangulate the template like MATLAB's `delaunay` when points are cocircular (exact predicates with CGAL's symbolic perturbation instead of Delaunator), and drop polygon spikes narrower than 1e-8 of the span as MATLAB's `polyshape` does. Maps from real Benson templates are unchanged. New MATLAB R2023b recordings cover polygon boundary sweeps, Delaunay ties, region growing and real templates of both hemispheres.
