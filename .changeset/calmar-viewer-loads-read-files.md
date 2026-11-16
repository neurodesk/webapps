---
"calmar": patch
"@neurodesk/webapp-components": patch
---

`ViewerController` loads given `assertCurrent` now decode their `File` with `NVImage.loadFromFile` instead of an object URL. A partly loaded 4D image (`limitFrames4D`) that leaves the viewer and is added again can still load its remaining frames, and a superseded load no longer leaves an object URL or a pending fetch behind. A file NiiVue cannot decode is still logged with the reason. Loads without `assertCurrent` are unchanged.
