---
"synthseg": patch
---

Correct the FreeSurfer labels in the viewer before downloading them. Edit on the result row opens the shared mask editor with a Label select that names each FreeSurfer structure, such as `17 — Left-Hippocampus`. Apply marks the row as edited, and Download then saves the edited labels as a uint8 NIfTI on SynthSeg's grid. The JSON report keeps the pipeline's labels and volumes. When the input image is not on SynthSeg's 1 mm grid, the editor shows the input resampled to that grid and the status bar says so. The overlay opacity slider no longer throws. It called `setOpacity`, which NiiVue 1.0 does not have, and now uses `setVolume`.
