---
"vesselboost": patch
---

Correct the vessel segmentation or the brain mask in the viewer before downloading it. Both result rows have an Edit button that opens the shared mask editor over the analysis image, with Draw, Erase and Fill tools, Undo, Apply and Cancel. Apply replaces the result, which is then labelled `(edited)`, and Download returns the edited mask as a uint8 NIfTI with the same name. Changing a setting or running a step again closes an open edit. The automation report keeps the masks the pipeline computed.
