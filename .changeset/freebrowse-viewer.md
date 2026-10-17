---
"dicomview": minor
"@neurodesk/runtime-support": minor
"topofit": patch
"spinalcordtoolbox": patch
---

DICOM View shows the selected series in FreeBrowse instead of a bare NiiVue canvas. Its Volumes panel sets the contrast range (window and level), opacity and colormap, and its header switches between axial, coronal, sagittal, 3D and multiplanar layouts and between contrast and pan for right-drag. The panel starts open where it leaves the image uncovered and closed on narrow screens. The Image, Header and Protocol tabs above the viewer replace the 3-Plane, Axial, Coronal and Sagittal tabs. The image is listed under its download name, which carries no study date.

The shared FreeBrowse viewer now runs FreeBrowse's development build (commit eae80a127f, vendored because it is not on npm) on NiiVue 1.0.0-rc.17. Wand fills in the Drawing panel can be undone. A volume's name in the Volumes and Surfaces panels is a button that Enter or Space selects, and the contrast, opacity and frame sliders are named for assistive technology. The eye button still hides a volume through its opacity, and now restores the opacity it had, until NiiVue releases volume visibility (niivue/mono#224).
