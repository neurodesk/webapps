---
"@neurodesk/runtime-support": patch
"@neurodesk/webapp-components": patch
---

Add helpers for the dcm2niix app. `runDcm2niix` takes a `timeoutMs` conversion deadline and terminates a stalled worker. `clearNiftiText` removes NIfTI header text and extensions and keeps geometry and voxels. Editable report fields share the workflow field styling, and clearing a workspace releases its automation output.
