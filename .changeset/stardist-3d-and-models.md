---
"stardist": minor
---

Add StarDist 3D (`3D_demo`) and the remaining official 2D pretrained models (`2D_versatile_he` for RGB H&E brightfield histology and `2D_paper_dsb2018`) alongside `2D_versatile_fluo`. Port StarDist 0.9.1's 3D tiling, continuous kernel/convex-hull and voxel-overlap 3D NMS, and polyhedron rasterization (`src/stardist3d.js`), add full-colour RGBA NIfTI display for H&E and 3-plane multiplanar NIfTI display for 3D stacks, add public-domain H&E skin histology and synthetic 3D examples, and validate every model's browser label TIFF and CSV table voxel/pixel-for-voxel against Python StarDist 0.9.1.
