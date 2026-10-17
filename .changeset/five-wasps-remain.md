---
"@neurodesk/elastix": patch
---

Fix `elastix-register --parameter-file` by passing the file paths in the ITK reader's `parameterFiles` options object. Custom parameter files and chains now load and run instead of failing before registration.
