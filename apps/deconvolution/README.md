# Deconvolution

Richardson-Lucy deconvolution of one widefield or confocal fluorescence stack in the browser,
optionally with total-variation regularisation, with a theoretical Gibson-Lanni PSF or a
measured one. The numerics are `@neurodesk/deconvolution` (Rust → WebAssembly, run in a module
worker per step; cancelling terminates it); TIFF reading and writing is
`@neurodesk/microscopy-tiff`. The method, its validation and its divergences are in
[`packages/deconvolution/README.md`](../../packages/deconvolution/README.md).

## Inputs and outputs

- One single-channel stack: TIFF, OME-TIFF, ImageJ TIFF or NIfTI. The voxel size comes from the
  file (OME-XML, ImageJ calibration, TIFF resolution or the NIfTI header) and can be corrected
  in the form; the theoretical PSF is computed on that grid.
- Optional measured PSF (Advanced settings), on the image's voxel size.
- Outputs: the deconvolved stack as float32 ImageJ TIFF (micrometre calibration) and gzipped
  NIfTI (spacing in millimetres, y flipped so row 0 shows at the top as in ImageJ; a NIfTI input
  keeps its own header), and the PSF used as TIFF. The input, both results and the PSF can be
  viewed in NiiVue.

## Example

`hela-phalloidin488-confocal.tif`: the `Raw.tif` crop of Romain Guiet's *Deconvolution Test
Dataset* (EPFL BIOP; Zenodo [5101351](https://doi.org/10.5281/zenodo.5101351), CC BY 4.0),
unchanged: HeLa cells, phalloidin-488 actin, Zeiss LSM 710 confocal, 63×/1.4 oil, 488 nm
excitation, 525 nm emission, 256 × 256 × 41 at 65.9 nm × 130 nm, 8-bit. The optics come from
the dataset's CZI metadata and are set with the example (`src/config.js`). Pinned at
`neurodeskorg/webapps@726eee4a` under `deconvolution/example/`.

## Tests

- `pnpm --filter deconvolution test`: config, input reading (TIFF and NIfTI in the same layout,
  NIfTI spacing in millimetres) and provenance.
- `pnpm --filter deconvolution test:e2e`: the example's 10-iteration run must equal
  `e2e/expected.json` (recorded in Node from the same module by `scripts/record-reference.mjs`)
  byte for byte, as TIFF and as NIfTI with 6.59e-5 × 1.3e-4 mm voxels; cancel; a failed example
  download retried with the real bytes; a measured PSF on an odd-sized TIFF; and the automation
  operation with RL-TV, each compared with the Node result.

Rerun `node scripts/record-reference.mjs` after rebuilding the module or changing the example.
