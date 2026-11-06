---
"spot-detection": minor
---

Add Spot detection, a browser port of Big-FISH's smFISH spot detector: LoG filter sized from the voxel size and spot radius, local maxima, the automatic elbow threshold and a Gaussian sub-pixel fit, on one 2D image or 3D TIFF stack or its maximum projection, with optional per-cell counts from a label image. It writes a spots CSV, a NIfTI overlay viewed over the image in NiiVue, and a per-cell counts CSV. On Big-FISH's example stack it finds the same 771 spots at the same automatic threshold (355) as Big-FISH 0.6.2, with a voxel-identical filtered image.
