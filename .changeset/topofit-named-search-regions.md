---
"topofit": minor
"@neurodesk/topofit": minor
---

The flat-patch search region can name a cortical area: a Wang et al. 2015 visual area (V1, V2, V3 to IPS5, SPL1 and FEF, the union of the visual areas, or a ventral or dorsal half), a Desikan-Killiany lobe or one of its 34 regions. The fsaverage label maps (`fsaverage-regions.bin`, pinned in `cortex-regions.manifest.json`) are carried to the subject through the registration spheres by the same nearest-vertex lookup as the cortex mask, and are downloaded only when a named region is chosen. Every patch vertex lies in the region; the analysis records the region and atlas, the manifest records the asset's SHA-256, and each searched hemisphere gets the mapped parcellation as a FreeSurfer annotation (`lh.wang2015.annot`). Automation takes the region as `patchRegion`. Searches of the whole cortex or an ROI give the same files as before.
