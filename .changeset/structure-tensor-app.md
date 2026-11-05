---
"structure-tensor": minor
"@neurodesk/webapp-components": minor
---

Add Structure Tensor, a fibre orientation app for microscopy using the OrientationJ method. It takes a 2D image or a 3D stack (TIFF, NIfTI, PNG, JPEG, or 2D slices) and computes Gaussian-derivative structure-tensor maps in the browser: orientation, coherency and energy, OrientationJ's HSB colour survey, an orientation distribution CSV and a dominant-direction summary. In 3D it also gives the fibre azimuth and elevation, a fibre coherency and an RGB direction map, with the fibre vectors as NIfTI. On the SHG collagen example the maps equal a scipy.ndimage reference to 1e-13°, and synthetic gratings and cylinder lattices give their true angles within 0.01°. The shared file-io gains `createRgb24Nifti` for colour NIfTI images.

`@neurodesk/webapp-components/file-io/tiff` can inspect a Blob or File range by range (only its page directories and description are read), read RGB pages as the mean of red, green and blue with `rgb: 'mean'`, reports `samplesPerPixel`, and writes RGB pages with `rgb: true`. Structure Tensor reads and writes TIFF through it.
