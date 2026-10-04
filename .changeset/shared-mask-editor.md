---
"@neurodesk/webapp-components": minor
---

Add a shared editor for correcting masks and label maps in the viewer. The `nd-mask-editor` element (`createMaskEditor`) is a second viewer toolbar row with Draw, Erase and Fill tools, a Label select for label maps, brush size, Undo, Apply and Cancel. It edits through NiiVue's drawing layer in both the 0.x and 1.0 generations (`createDrawingAdapter` in `@neurodesk/webapp-components/viewer`). Apply returns the result on its own grid as a uint8 NIfTI with the result's name. `createResultList` shows an Edit button for results marked `editable` and labels edited results. On NiiVue 1.0 rc.11 to rc.14 the adapter corrects a NiiVue load error that put masks on the wrong voxels of images with permuted axes, such as sagittal acquisitions.
