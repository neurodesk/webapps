---
"topofit": minor
"@neurodesk/topofit": minor
---

A named search region can now be viewed two ways. View on a hemisphere's parcellation draws the mapped atlas on its mid-surface, the search region in its atlas colours, the other areas faded, found patches white, and turns the 3D view to face the region. A new output, `topofit_region_mask.nii`, holds the region filled between the white and pial surfaces on the source grid (unsigned 8-bit, left 1, right 2); View overlays it on the original image's slices. The app and the `topofit` command line write the same mask, automation returns it as the `region-mask` artifact, and `readAnnotation` reads a written parcellation back. Searches of the whole cortex or an ROI, and every other file of a named-region search, are unchanged.
