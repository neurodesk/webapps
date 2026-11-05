---
"deconvolution": minor
"@neurodesk/deconvolution": minor
"@neurodesk/microscopy-tiff": minor
---

Add Deconvolution, a microscopy app that sharpens one widefield or confocal stack in the browser with Richardson-Lucy, optionally regularised by total variation (Dey et al. 2006), using a theoretical Gibson-Lanni PSF for the objective or a measured bead stack. It reads TIFF, OME-TIFF, ImageJ TIFF and NIfTI with their voxel size, and downloads the deconvolved stack as calibrated TIFF and NIfTI with the PSF used. `@neurodesk/deconvolution` holds the Rust core as committed WebAssembly: its Richardson-Lucy equals scikit-image's to 2e-14 and its PSF equals adaptive quadrature of the Gibson-Lanni integral to 2e-7 and psfmodels within 7e-5. `@neurodesk/microscopy-tiff` reads single-channel stacks for any microscopy app, honouring the photometric interpretation, alpha samples, prefixed OME-XML and a memory budget.
