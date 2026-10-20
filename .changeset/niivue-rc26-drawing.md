---
"@neurodesk/webapp-components": patch
"@neurodesk/runtime-support": patch
"brain-extraction": patch
"carotid-flow": patch
"syncro": patch
"synthseg": patch
"white-matter-lesions": patch
"spinalcordtoolbox": patch
"dicomview": patch
"topofit": patch
"musclemap": patch
"seedseg": patch
"vesselboost": patch
---

NiiVue moves to 1.0.0-rc.26 in Brain Extraction, Carotid Flow, SYNcro, SynthSeg, White Matter Lesions, and, through the shared FreeBrowse viewer, Spinal Cord Toolbox, DICOM View and TopoFit. From rc.25, NiiVue places a loaded drawing on the right voxels of a sagittal or otherwise permuted image (niivue/mono#251), so the mask editor no longer probes and reverses NiiVue's load on opening a mask. Opening a mask for editing now takes one load instead of up to five on such images. MuscleMap, SeedSeg and VesselBoost run NiiVue 0.68, which already loaded drawings correctly; they pick up the simpler editor.
