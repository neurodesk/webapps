---
"zarro": patch
---

Update NiiVue to 1.0.0-rc.186. NVSlide panes now load the stored uint8 or uint16 voxels and apply the intensity window on the GPU. A window change redraws the cached tiles without rebuilding the pane or fetching tiles again, and uint16 data is no longer reduced to 8 bits before display.
