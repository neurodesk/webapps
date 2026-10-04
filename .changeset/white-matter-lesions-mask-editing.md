---
"white-matter-lesions": patch
---

Correct the lesion mask in the viewer before downloading it. Edit on the lesion mask row opens the shared editor over the FLAIR with Draw, Erase and Fill tools. Apply replaces the mask in the Output list and recomputes the lesion count, volume and lesion table from the edited mask, marking both rows `(edited)`. Download returns the edited mask under the same name as a uint8 NIfTI. Cancel discards the strokes. Loading a new image or segmenting again closes an open edit. The probability map and the run report remain as the model produced them.
