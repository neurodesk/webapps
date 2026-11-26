---
"vesselcharter": patch
"@neurodesk/vesselcharter": patch
"@neurodesk/webapp-components": patch
---

Improve VesselCharter diameter map colouring and add a shared viewer colour-scale legend: switch the default diameter palette for both the 3D Vessel Tree and 2D/3D Diameter Map NIfTI to Turbo over a strictly positive, outlier-robust display range (keeping zero background transparent without hiding thin vessels, and writing calibrated `cal_min`/`cal_max` into exported NIfTIs), add shared `.nd-viewer-legend` styles to `imaging-workspace.css`, show a live colour-scale legend (with mm ticks and threshold/clipping indicators, plus categorical swatches for Skeleton Topology), and add toolbar colormap switching and validated min/max mm scale controls.
