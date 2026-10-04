---
"brain-extraction": patch
---

Correct the brain mask in the viewer before downloading it. Edit on the brain mask row shows the mask in red over the input image and opens the shared editor with Draw, Erase and Fill tools. Apply replaces the mask in the Output list, which then reads `Brain mask (edited)`, and Download returns the edited mask under the same name as a uint8 NIfTI. Cancel discards the strokes. Loading a new image or running extraction again closes an open edit. The brain image and the run report remain as extraction produced them.
