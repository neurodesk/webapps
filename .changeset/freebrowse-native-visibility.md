---
"@neurodesk/runtime-support": patch
"spinalcordtoolbox": patch
"topofit": patch
"dicomview": patch
---

The FreeBrowse viewer's eye button now hides a volume through NiiVue's own `visible` flag, which NiiVue draws from 1.0.0-rc.24, instead of a shim that set the volume's opacity to 0. A hidden volume keeps its opacity, so the Opacity slider shows the real value while it is hidden. Spinal Cord Toolbox's Results eye buttons hide a stage the same way, keeping its opacity, so either eye can show what the other hid, in the main viewer and in Compare. TopoFit's 3D anatomy clip and its patch QC result follow the flag: hiding the QC volume with FreeBrowse's eye clears its measurements as before.
