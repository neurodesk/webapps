---
"stardist": minor
---

Add StarDist, a new app that segments cell nuclei in 2D fluorescence microscopy with StarDist's pretrained `2D_versatile_fluo` model. It reads TIFF, OME-TIFF and PNG images (one chosen channel), runs the model with ONNX Runtime Web on the CPU in overlapping tiles, and ports StarDist's non-maximum suppression and label drawing. It downloads a label TIFF and a per-nucleus CSV table (centroid, area, mean intensity, probability) and shows the labels filled or as outlines. On the DSB 2018 example its 118 nuclei equal Python StarDist 0.9.1's pixel for pixel.
