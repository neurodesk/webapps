---
"@neurodesk/webapp-components": patch
---

Add an opt-in native NiiVue wand adapter that sets intensity bounds from image contrast, handles signed seeds and NIfTI intensity scaling, and preserves connectivity, radius, previews and Undo. Restore the original viewer method when the adapter is removed. Existing viewers do not opt in automatically.
