---
"white-matter-lesions": minor
"@neurodesk/white-matter-lesions": patch
---

Step through segmented lesions in the viewer. ‹ and › centre the crosshair on each lesion in turn, largest first, and the Overlay toggle hides the mask or probability map to check the FLAIR beneath. The Output section shows the lesion count and the total, largest, median and smallest lesion volume. `lesionResults` now also returns the ranked lesions (`lesions`: volume and centroid in mm).
