---
"@neurodesk/runtime-support": patch
"spinalcordtoolbox": patch
"topofit": patch
"dicomview": patch
---

The FreeBrowse viewer's eye button now hides a volume through NiiVue's own `visible` flag, which NiiVue draws from 1.0.0-rc.24, instead of a shim that set the volume's opacity to 0. A hidden volume keeps its opacity, so the Opacity slider shows the real value while it is hidden. Spinal Cord Toolbox's Results eye buttons and TopoFit's 3D anatomy clip follow the flag: hiding or showing a volume with FreeBrowse's eye updates them, and showing a stage from Results also clears a FreeBrowse hide.
