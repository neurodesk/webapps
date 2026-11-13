# @neurodesk/deconvolution

## 0.2.1

### Patch Changes

- 37be3c2: Refuse a computed PSF for voxels over ten Airy radii or depths of field, such as a millimetre-scale MRI, with a message instead of running WebAssembly out of memory.

## 0.2.0

### Minor Changes

- d643e8d: Add Deconvolution, a microscopy app that sharpens one widefield or confocal stack in the browser with Richardson-Lucy, optionally regularised by total variation (Dey et al. 2006), using a theoretical Gibson-Lanni PSF for the objective or a measured bead stack. It reads TIFF, OME-TIFF, ImageJ TIFF and NIfTI with their voxel size, and downloads the deconvolved stack as calibrated TIFF and NIfTI with the PSF used. `@neurodesk/deconvolution` holds the Rust core as committed WebAssembly: its Richardson-Lucy equals scikit-image's to 2e-14 and its PSF equals adaptive quadrature of the Gibson-Lanni integral to 2e-7 and psfmodels within 8e-5. The shared TIFF reader (`@neurodesk/webapp-components/file-io/tiff`) now reads an ImageJ 8-bit palette stack as intensity, the grey sample of grey + alpha pages and inverted WhiteIsZero integers, skips reduced-resolution pages, follows OME TiffData plane mapping (refusing planes in other files, and taking an interleaved RGB or grey + alpha channel, which OME counts as several in SizeC, as one page per plane), leaves a plain TIFF's page axis unknown rather than calling its pages time points, and `imagejDescription` describes a calibrated z stack.

  Refuse a NIfTI whose decoded image is over the limit from its header, before inflating it, bound decompression against a header that understates its data, reject oversized source files before reading them, and check cancellation around input decoding.
