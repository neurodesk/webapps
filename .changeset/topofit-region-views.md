---
"topofit": minor
"@neurodesk/topofit": minor
---

A named search region can now be viewed two ways. View on a hemisphere's parcellation draws the mapped atlas on its mid-surface, the search region in its atlas colours, the other areas faded, found patches white, and turns the 3D view to face the region. A new output, `topofit_region_mask.nii`, holds the region filled between the white and pial surfaces on the source grid (unsigned 8-bit, left 1, right 2); View overlays it on the original image's slices. The app and the `topofit` command line write the same mask, automation returns it as the `region-mask` artifact, and `readAnnotation` reads a written parcellation back. Searches of the whole cortex or an ROI are byte-identical, manifest included. In a named-region search every earlier file is byte-identical except the processing manifest, which lists every output and so gains the mask's SHA-256 entry. A NIfTI-2 scan now gets valid NIfTI-1 QC, patch QC and mask images with its own grid; until now their headers were NIfTI-2 bytes copied into a NIfTI-1 layout, which no reader could open as the scan's grid.
