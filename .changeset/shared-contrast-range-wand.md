---
"@neurodesk/webapp-components": patch
---

Add an opt-in native NiiVue wand adapter that sets intensity bounds from image contrast, handles signed seeds and NIfTI intensity scaling, and preserves connectivity, radius, previews and Undo. Restore the original viewer method when the adapter is removed. Existing viewers do not opt in automatically.

Support an optional RAS brain mask as a connectivity barrier, reject outside seeds, and convert matching native NIfTI masks using the viewer signed axis permutation.

Add a synchronous drawing-to-native voxel-order conversion with base-grid checks for native mask export and confirmation.
