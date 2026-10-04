---
"spinalcordtoolbox": patch
---

Correct segmentation and label results by hand before downloading them. Every mask and label-map row in Results (cord, lesion, TotalSpineSeg labels and disc markers) now has an Edit button that opens the shared mask editor under the viewer toolbar, with the input image as the base. Apply replaces the result with the edited uint8 NIfTI under the same file name and labels the row `(edited)`; Download then returns the edit. Cancel, a new run, Clear results, a new input or hiding the edited overlay discard unapplied strokes. Lesion statistics and automation reports keep the values the pipeline computed.
