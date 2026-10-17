# elastix

elastix registers a moving image to a stationary image entirely in the browser
with [`@itk-wasm/elastix`](https://github.com/InsightSoftwareConsortium/ITKElastix),
the WebAssembly build of [elastix](https://github.com/SuperElastix/elastix). The
interface follows the registration family: moving, stationary and registered
images in linked NiiVue panels, one Register action, and downloads in the output
section. It is based on ITKElastix's TypeScript demo app.

Registered images download as NIfTI, OME-Zarr and, for compatible grids,
deflate-compressed OME-TIFF. The TIFF export keeps the float32 registration
result on the selected registration grid, including its physical spacing
and stationary input units. It uses
the same `@fideus-labs/fiff` writer as the upstream demo, through the shared
`@neurodesk/elastix` package so the command line writes the same file.

The pinned TIFF writer cannot store origin or direction. OME-TIFF is offered
only for zero-origin grids with identity direction and known physical sizes
and spatial units from the stationary OME-TIFF or OME-Zarr input. TIFF export
validates the original 2016-06 OME XML against the selected TIFF directories.
Physical sizes must be positive finite numbers without suffixes. Explicit
units must be supported; only absent units use the schema's micrometer default.
The shared reader normalizes XML quoting, namespace prefixes and character
references before fiff reads those values. Single-quoted calibration therefore
has the same meaning in the browser and command line.

The calibration check supports scalar XY or XYZ images with one channel and
time point, verifiable local TiffData mappings and genuine SubIFD pyramids.
Ambiguous mappings and other layouts disable TIFF export. Plane positions
inside the selected Image disable export because the registration reader does
not preserve them. Positions on another Image do not affect that decision.
In fiff's legacy multi-image path, selection can use another Image's pixels
with the first Image's spacing. This change refuses TIFF when that grid
disagrees with the selected Image's original calibration. It does not repair
that registration geometry; the other outputs retain the reader's grid.
Registration also does not convert between unlike moving and stationary units.
Other ITK inputs do not retain
explicit units in this reader. The Output section explains why TIFF is
unavailable; use NIfTI or OME-Zarr for those grids. No resampling, orientation
changes or intensity conversion are performed for TIFF export.

## Methods

Each preset chains elastix's default parameter maps (`defaultParameterMap`):
Rigid is translation then rigid, Affine adds affine, and Affine + B-spline adds a
B-spline deformation with the chosen final grid spacing. Advanced settings set
the number of resolutions. Elastix parameter files (`.txt` or `.toml`) replace the
preset; they run in file-name order.

Both images are cast to float32 before registration, so any pair of pixel types
registers and the result is never wrapped into an integer range. The transform
maps stationary points to moving points, as ITK and elastix define it. The
TransformParameters downloads use elastix's TOML format and name their
predecessors, so transformix given the last file applies every stage.

The transform downloads as ITK HDF5 and as an OME-Zarr archive holding an RFC-5
transformation from the `fixed` to the `moving` coordinate system, in the images'
intrinsic (OME-Zarr) coordinates. elastix evaluates it for the archive: transformix
resamples coordinate images, two voxels per axis whose values are their own
physical coordinate relative to the moving origin, retaining tiny spans even
on strongly translated grids. The pinned sampler uses float32 internally.
A centered, scaled QR solve fits a linear transform from the stationary
image's corners; export rejects non-finite coefficients, degenerate grids
and residuals beyond the sampler's rounding bound before writing one `affine`; a B-spline, or any other
non-linear stage from a parameter file, is sampled at every stationary voxel and
written as a `displacements` field.

## Inputs

| Source | Reader |
| --- | --- |
| NIfTI, DICOM | dcm2niix (DICOM), then `@itk-wasm/image-io` |
| Self-contained scalar ITK files, including NRRD (`.nrrd`), MetaImage (`.mha`), MGH and MINC | `@itk-wasm/image-io` |
| OME-Zarr `.ozx`, a dropped `.zarr` folder, an OME-Zarr URL | `@fideus-labs/ngff-zarr` (zip archives through `@zarrita/storage`) |
| TIFF and OME-TIFF, local or by URL | `@fideus-labs/fiff` over geotiff, by range request for a URL |

Detached headers (`.mhd`, `.nhdr`) with external pixel files are unsupported.
Save a self-contained `.mha` or `.nrrd` image, or convert the pair to NIfTI before
loading it. ITK files must contain one scalar 2D or 3D image. OME-Zarr and TIFF
channel and time axes reduce to the first scalar volume.

Pyramids register at the finest level of at most 2^24 voxels. A single-slice
volume becomes a 2D image when its plane lies in physical XY.
Sagittal and oblique single-slice volumes are rejected because reducing them to
2D would discard their physical coordinates.

## Build and test

`scripts/copy-pipelines.mjs` stages the ITK-Wasm pipelines the app calls into the
ignored `public/pipelines/` before `dev` and `build`; `src/pipelines.js` points
every ITK-Wasm package there, so nothing is fetched from a CDN.

```bash
pnpm --filter elastix build
pnpm --filter elastix test
pnpm --filter elastix test:e2e
```

The browser tests resample the moving image through each downloaded OME-Zarr
transform, using only the archive and the NIfTI affines, and require it to match
elastix's registered image. They also register the example pair at 2 mm and the
hosted 1 mm pair, a known rigid displacement through the automation contract,
and a synthetic 2D pair with a known shift as local OME-Zarr, local OME-TIFF, a
remote OME-Zarr folder and a remote TIFF served by range request, plus a
two-level pyramidal OME-TIFF.

## Command line

`elastix-register` from `packages/elastix` runs the same presets with Node, on
the same ITK-Wasm pipelines:

```bash
elastix-register moving.nii.gz fixed.nii.gz results --method affine
```

It writes the downloads under the web app's names, except the registered
OME-Zarr image. It has no DICOM import. Portable archives for Linux x64,
Windows x64 and macOS arm64 bundle their own Node runtime. Their release check
holds every output to this app's own downloads, recorded by
`e2e/reference.spec.js`. See
[packages/elastix/README.md](../../packages/elastix/README.md).

B-spline runs offer no ITK HDF5 transform: `@itk-wasm/transform-io` 1.1.0
fails writing a BSpline transform. Use the TransformParameters files or the
OME-Zarr transform.

## Archive dependencies

ITK-Wasm's Node data archive manager is pinned to the maintained
`@xhmikosr/decompress@11.1.4` and `tar@7.5.22` through scoped workspace overrides.
The one-line `@itk-wasm/dam` patch uses tar's namespace export for compatibility.
Archive tests resolve the actual ITK dependency, pack and extract a valid archive,
and reject direct and chained escaping symlinks. These Node archive tools are not
the browser's OME-Zarr ZIP reader.
