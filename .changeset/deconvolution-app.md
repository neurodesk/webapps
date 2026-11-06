---
"deconvolution": minor
"@neurodesk/deconvolution": minor
"@neurodesk/webapp-components": minor
---

Add Deconvolution, a microscopy app that sharpens one widefield or confocal stack in the browser with Richardson-Lucy, optionally regularised by total variation (Dey et al. 2006), using a theoretical Gibson-Lanni PSF for the objective or a measured bead stack. It reads TIFF, OME-TIFF, ImageJ TIFF and NIfTI with their voxel size, and downloads the deconvolved stack as calibrated TIFF and NIfTI with the PSF used. `@neurodesk/deconvolution` holds the Rust core as committed WebAssembly: its Richardson-Lucy equals scikit-image's to 2e-14 and its PSF equals adaptive quadrature of the Gibson-Lanni integral to 2e-7 and psfmodels within 8e-5. The shared TIFF reader (`@neurodesk/webapp-components/file-io/tiff`) now reads an ImageJ 8-bit palette stack as intensity, the grey sample of grey + alpha pages and inverted WhiteIsZero integers, skips reduced-resolution pages, follows OME TiffData plane mapping (refusing planes in other files), leaves a plain TIFF's page axis unknown rather than calling its pages time points, and `imagejDescription` describes a calibrated z stack.

Bound compressed NIfTI decoding before allocating the full image, reject oversized source files before reading them, and check cancellation around input decoding.
