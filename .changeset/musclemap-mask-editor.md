---
"musclemap": patch
---

Correct a segmentation in the viewer before downloading it. Generated, consolidated and uploaded label maps whose display copy shares their voxel grid show Edit in the Results list, which opens the shared mask editor with the muscle names in its Label select. Apply replaces the result, labels it `(edited)`, reloads the overlay and makes Download return the edited uint8 class-index map under the same file name; Calculate Metrics then reads the edited labels. A new run, new input, consolidation or Clear All closes an open edit without applying it.
