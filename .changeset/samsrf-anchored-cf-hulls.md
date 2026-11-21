---
"@neurodesk/samsrf": patch
---

Connective-field convex hulls (`Fit_pRF = 0`) take MATLAB's stored vertex order wherever the cluster's first point starts the hull, in general position and with a hull of input points, and the previous evaluation everywhere else. Every value the previous evaluation gave exactly stays exact. On the SamSrfAnalysis matrix, 16 more `y0` values per host equal MATLAB's (the double convex-hull runs' remaining differences drop from 16 to 7 and from 12 to 5), with no other output changed. On the recordings, 26 more real-template values per precision, 141 more reverse-correlation CF values and 77,481 more polygon values per host equal MATLAB's. Reverse-correlation hulls are unchanged.
